/**
 * GSTR-1 (monthly outward supplies) for one business GSTIN, built from issued invoices and credit
 * notes: B2B, B2CL, B2CS (net of credit notes on B2CS invoices), CDNR, CDNUR, HSN summary (B2B and
 * B2C, net of credit notes), 0% lines and documents issued (cancelled invoices and credit notes
 * count only there), plus CSV files with the GST offline tool's column layout. Every invoice's
 * lines are reconciled to its saved totals, so the tables agree with the invoices. A CA should
 * still review the return before filing.
 */

import { HttpError } from '../../middleware/errors.js';
import { STATES, calculateLineAmount, documentRoundingPolicy } from '../../../shared/types.js';
import { decimal } from '../../../shared/decimal.js';
import { csvRow } from '../ledger/ledger-values.js';

const STATE_NAMES = new Map(STATES);
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Invoices to unregistered buyers in another state above this value are B2CL
// (₹1 lakh from 1 August 2024, ₹2.5 lakh before).
const b2clLimit = (issueDate) => (issueDate >= '2024-08-01' ? 100000 : 250000);
// GST unit codes (UQC) for the editor's units; services (SAC 99xx) use NA, anything else OTH.
const UQC = {
  Nos: 'NOS-NUMBERS',
  Unit: 'UNT-UNITS',
  Piece: 'PCS-PIECES',
  Kg: 'KGS-KILOGRAMS',
  Gram: 'GMS-GRAMMES',
  Meter: 'MTR-METERS',
  'Sq ft': 'SQF-SQUARE FEET',
  'Sq m': 'SQM-SQUARE METERS',
  Set: 'SET-SETS',
};

const HSN_COLUMNS = [
  'HSN',
  'Description',
  'UQC',
  'Total Quantity',
  'Total Value',
  'Rate',
  'Taxable Value',
  'Integrated Tax Amount',
  'Central Tax Amount',
  'State/UT Tax Amount',
  'Cess Amount',
];
/** Section key -> title and CSV columns (the offline tool's headings). */
export const GSTR1_SECTIONS = {
  b2b: {
    title: 'B2B – registered buyers (4A)',
    columns: [
      'GSTIN/UIN of Recipient',
      'Receiver Name',
      'Invoice Number',
      'Invoice date',
      'Invoice Value',
      'Place Of Supply',
      'Reverse Charge',
      'Applicable % of Tax Rate',
      'Invoice Type',
      'E-Commerce GSTIN',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  },
  b2cl: {
    title: 'B2CL – large inter-state invoices to unregistered buyers (5)',
    columns: [
      'Invoice Number',
      'Invoice date',
      'Invoice Value',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ],
  },
  b2cs: {
    title: 'B2CS – other sales to unregistered buyers (7)',
    columns: [
      'Type',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ],
  },
  cdnr: {
    title: 'CDNR – credit notes to registered buyers (9B)',
    columns: [
      'GSTIN/UIN of Recipient',
      'Receiver Name',
      'Note Number',
      'Note Date',
      'Note Type',
      'Place Of Supply',
      'Reverse Charge',
      'Note Supply Type',
      'Note Value',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  },
  cdnur: {
    title: 'CDNUR – credit notes on B2CL invoices (9B)',
    columns: [
      'UR Type',
      'Note Number',
      'Note Date',
      'Note Type',
      'Place Of Supply',
      'Note Value',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  },
  'hsn-b2b': { title: 'HSN summary – B2B (12)', columns: HSN_COLUMNS },
  'hsn-b2c': { title: 'HSN summary – B2C (12)', columns: HSN_COLUMNS },
  nil: {
    title: '0% GST lines – nil rated / exempt / non-GST (8)',
    columns: [
      'Description',
      'Nil Rated Supplies',
      'Exempted(other than nil rated/non GST supply)',
      'Non-GST supplies',
    ],
  },
  docs: {
    title: 'Documents issued (13)',
    columns: ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
  },
};

const money = (value) => decimal(value).round().toNumber().toFixed(2);
const portalDate = (iso) =>
  `${iso.slice(8, 10)}-${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const placeOfSupply = (code) => `${code}-${STATE_NAMES.get(code) ?? ''}`;

/** Reads ?month=YYYY-MM (default: the current month) and ?gstin= from the page URL. */
export function readGstr1Filters(query = {}, businessDate) {
  const month =
    typeof query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)
      ? query.month
      : businessDate.slice(0, 7);
  const gstin = typeof query.gstin === 'string' && /^[0-9A-Z]{15}$/.test(query.gstin) ? query.gstin : '';
  return { month, gstin };
}

/** First day of the month and of the next month, for an issueDate range query. */
export function monthRange(month) {
  const [year, number] = month.split('-').map(Number);
  const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

/**
 * Splits one invoice into lines with taxable value and tax, rounded per line, then moves any
 * rounding difference onto the largest line so the lines add up to the saved invoice totals.
 */
export function invoiceLines(document) {
  const policy = documentRoundingPolicy(document);
  const factor = decimal(1).minus(decimal(document.discountPercent ?? 0).times(0.01));
  const lines = document.items.map((item) => {
    const raw = decimal(calculateLineAmount(item, policy)).times(factor);
    return {
      hsn: String(item.hsn ?? '').trim(),
      description: item.description ?? '',
      unit: item.unit ?? '',
      quantity: Number.isFinite(item.quantity) ? item.quantity : 0,
      rate: Number(item.gstRate) || 0,
      taxable: raw.round(),
      tax: raw
        .times(Number(item.gstRate) || 0)
        .times(0.01)
        .round(),
    };
  });
  if (!lines.length) return lines;
  const totals = document.totals;
  const largest = lines.reduce((best, line) =>
    line.taxable.toNumber() > best.taxable.toNumber() ? line : best,
  );
  const sum = (key) => lines.reduce((total, line) => total.plus(line[key]), decimal(0));
  largest.taxable = largest.taxable.plus(decimal(totals.taxable).minus(sum('taxable'))).round();
  const savedTax = decimal(totals.igst ?? 0)
    .plus(totals.cgst ?? 0)
    .plus(totals.sgst ?? 0);
  largest.tax = largest.tax.plus(savedTax.minus(sum('tax'))).round();
  return lines;
}

/**
 * Splits a credit note's taxable value and tax over the invoice lines at its GST rate, in
 * proportion to their taxable value (whole paise, the last line takes the remainder), so the HSN
 * summary can be reduced by the right codes.
 */
export function creditNoteHsnLines(invoice, { gstRate, taxable, tax }) {
  const lines = invoiceLines(invoice).filter((line) => line.rate === gstRate);
  const paise = (value) => BigInt(Math.round(decimal(value).toNumber() * 100));
  const base = lines.reduce((sum, line) => sum + paise(line.taxable), 0n);
  const total = { taxable: paise(taxable), tax: paise(tax) };
  const given = { taxable: 0n, tax: 0n };
  return lines.map((line, index) => {
    const part = (key) => {
      const share =
        index === lines.length - 1
          ? total[key] - given[key]
          : base
            ? (total[key] * paise(line.taxable) * 2n + base) / (2n * base)
            : 0n;
      given[key] += share;
      return Number(share) / 100;
    };
    return {
      hsn: line.hsn,
      description: line.description,
      unit: line.unit,
      taxable: part('taxable'),
      tax: part('tax'),
    };
  });
}

/**
 * Invoice number series for Table 13: "ABC/2627/0007" belongs to series "ABC/2627/". Total and
 * cancelled are counts of the invoices found; numbers missing from a series are not guessed.
 */
function documentSeries(invoices, nature) {
  const series = new Map();
  for (const doc of invoices) {
    const prefix = doc.number.replace(/\d+$/, '');
    const position = Number(doc.number.slice(prefix.length) || 0);
    const row = series.get(prefix) ?? {
      from: doc,
      to: doc,
      fromAt: position,
      toAt: position,
      total: 0,
      cancelled: 0,
    };
    if (position < row.fromAt) Object.assign(row, { from: doc, fromAt: position });
    if (position > row.toAt) Object.assign(row, { to: doc, toAt: position });
    row.total++;
    if (doc.status === 'cancelled') row.cancelled++;
    series.set(prefix, row);
  }
  return [...series.values()]
    .sort((a, b) => a.from.number.localeCompare(b.from.number))
    .map((row) => [nature, row.from.number, row.to.number, row.total, row.cancelled]);
}

/**
 * Builds the GSTR-1 tables for one month from issued and cancelled invoices (debit notes among them)
 * and credit notes, already filtered by business and month. Only records issued under `gstin` are
 * included; the default is the first GSTIN found. Cancelled records appear only in the
 * documents-issued table.
 */
export function buildGstr1(invoices, { month, gstin = '' }, creditNotes = []) {
  const gstins = [
    ...new Set([...invoices, ...creditNotes].map((doc) => doc.organizationSnapshot?.gstin).filter(Boolean)),
  ].sort();
  const selected = gstins.includes(gstin) ? gstin : (gstins[0] ?? '');
  const issued = invoices.filter((doc) => doc.status !== 'cancelled');
  const withoutGstin = issued.filter((doc) => !doc.organizationSnapshot?.gstin).length;
  const forGstin = invoices.filter((doc) => doc.organizationSnapshot?.gstin === selected);
  const chosen = forGstin
    .filter((doc) => doc.status !== 'cancelled')
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number));
  const b2b = [];
  const b2cl = [];
  const b2cs = new Map();
  const cdnr = [];
  const cdnur = [];
  const hsn = { 'hsn-b2b': new Map(), 'hsn-b2c': new Map() };
  const nil = new Map();
  const totals = { invoices: chosen.length, value: decimal(0), taxable: decimal(0), tax: decimal(0) };
  let missingHsn = 0;
  const add = (map, key, create, update) => {
    if (!map.has(key)) map.set(key, create());
    update(map.get(key));
  };
  const addAmount = (map, key, amount) => map.set(key, (map.get(key) ?? decimal(0)).plus(amount));
  // Adds one line to the HSN summary; a credit note line passes sign -1 and no quantity.
  const addHsn = (buyerGstin, interstate, line, sign = 1) => {
    const taxable = decimal(line.taxable).times(sign);
    const tax = decimal(line.tax).times(sign);
    const central = interstate ? decimal(0) : decimal(line.tax).times(0.5).round().times(sign);
    add(
      hsn[buyerGstin ? 'hsn-b2b' : 'hsn-b2c'],
      `${line.hsn}|${line.unit}|${line.rate}`,
      () => ({
        hsn: line.hsn,
        description: line.description,
        unit: line.unit,
        rate: line.rate,
        quantity: 0,
        value: decimal(0),
        taxable: decimal(0),
        igst: decimal(0),
        cgst: decimal(0),
        sgst: decimal(0),
      }),
      (row) => {
        if (sign > 0) row.quantity += line.quantity;
        row.value = row.value.plus(taxable).plus(tax);
        row.taxable = row.taxable.plus(taxable);
        if (interstate) row.igst = row.igst.plus(tax);
        else {
          row.cgst = row.cgst.plus(central);
          row.sgst = row.sgst.plus(tax.minus(central));
        }
      },
    );
  };

  for (const doc of chosen) {
    const buyerGstin = String(doc.customerSnapshot?.gstin ?? '').trim();
    const interstate = doc.placeOfSupply !== doc.organizationSnapshot.stateCode;
    const value = doc.totals.total;
    // A debit note goes to CDNR / CDNUR like a credit note (by its original invoice), or adds to B2CS.
    const debit = doc.debitNoteFor;
    const kind = debit
      ? buyerGstin
        ? 'cdnr'
        : interstate && debit.total > b2clLimit(debit.issueDate)
          ? 'cdnur'
          : 'b2cs'
      : buyerGstin
        ? 'b2b'
        : interstate && value > b2clLimit(doc.issueDate)
          ? 'b2cl'
          : 'b2cs';
    const lines = invoiceLines(doc);
    totals.value = totals.value.plus(value);
    const rates = new Map();
    for (const line of lines) {
      totals.taxable = totals.taxable.plus(line.taxable);
      totals.tax = totals.tax.plus(line.tax);
      if (!line.hsn) missingHsn++;
      addHsn(buyerGstin, interstate, debit ? { ...line, quantity: 0 } : line);
      if (line.rate === 0)
        addAmount(
          nil,
          `${interstate ? 'Inter' : 'Intra'}-State supplies to ${buyerGstin ? 'registered' : 'unregistered'} persons`,
          line.taxable,
        );
      else addAmount(rates, line.rate, line.taxable);
    }
    for (const [rate, taxable] of rates) {
      if (kind === 'cdnr')
        cdnr.push([
          buyerGstin,
          doc.customerSnapshot.name,
          doc.number,
          portalDate(doc.issueDate),
          'D',
          placeOfSupply(doc.placeOfSupply),
          'N',
          'Regular B2B',
          money(value),
          '',
          rate,
          money(taxable),
          '0.00',
        ]);
      else if (kind === 'cdnur')
        cdnur.push([
          'B2CL',
          doc.number,
          portalDate(doc.issueDate),
          'D',
          placeOfSupply(doc.placeOfSupply),
          money(value),
          '',
          rate,
          money(taxable),
          '0.00',
        ]);
      else if (kind === 'b2b')
        b2b.push([
          buyerGstin,
          doc.customerSnapshot.name,
          doc.number,
          portalDate(doc.issueDate),
          money(value),
          placeOfSupply(doc.placeOfSupply),
          'N',
          '',
          'Regular B2B',
          '',
          rate,
          money(taxable),
          '0.00',
        ]);
      else if (kind === 'b2cl')
        b2cl.push([
          doc.number,
          portalDate(doc.issueDate),
          money(value),
          placeOfSupply(doc.placeOfSupply),
          '',
          rate,
          money(taxable),
          '0.00',
          '',
        ]);
      else
        add(
          b2cs,
          `${doc.placeOfSupply}|${rate}`,
          () => ({ place: doc.placeOfSupply, rate, taxable: decimal(0) }),
          (row) => {
            row.taxable = row.taxable.plus(taxable);
          },
        );
    }
  }

  const notes = creditNotes.filter((note) => note.organizationSnapshot?.gstin === selected);
  for (const note of notes.filter((row) => row.status !== 'cancelled')) {
    const buyerGstin = String(note.customerSnapshot?.gstin ?? '').trim();
    const date = portalDate(note.noteDate);
    for (const line of note.hsnLines ?? [])
      addHsn(buyerGstin, note.interstate, { ...line, rate: note.gstRate }, -1);
    if (buyerGstin)
      cdnr.push([
        buyerGstin,
        note.customerSnapshot.name,
        note.number,
        date,
        'C',
        placeOfSupply(note.placeOfSupply),
        'N',
        'Regular B2B',
        money(note.total),
        '',
        note.gstRate,
        money(note.taxable),
        '0.00',
      ]);
    else if (note.interstate && note.invoiceTotal > b2clLimit(note.invoiceDate))
      cdnur.push([
        'B2CL',
        note.number,
        date,
        'C',
        placeOfSupply(note.placeOfSupply),
        money(note.total),
        '',
        note.gstRate,
        money(note.taxable),
        '0.00',
      ]);
    // B2CS is reported net: a credit note on a B2CS invoice lowers that place and rate's value.
    else
      add(
        b2cs,
        `${note.placeOfSupply}|${note.gstRate}`,
        () => ({ place: note.placeOfSupply, rate: note.gstRate, taxable: decimal(0) }),
        (row) => {
          row.taxable = row.taxable.minus(note.taxable);
        },
      );
  }

  const hsnRows = (map) =>
    [...map.values()]
      .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
      .map((row) => [
        row.hsn,
        row.description,
        row.hsn.startsWith('99') ? 'NA' : (UQC[row.unit] ?? 'OTH-OTHERS'),
        Number(row.quantity.toFixed(3)),
        money(row.value),
        row.rate,
        money(row.taxable),
        money(row.igst),
        money(row.cgst),
        money(row.sgst),
        '0.00',
      ]);
  return {
    month,
    gstin: selected,
    gstins,
    withoutGstin,
    missingHsn,
    totals: {
      invoices: totals.invoices,
      value: money(totals.value),
      taxable: money(totals.taxable),
      tax: money(totals.tax),
    },
    sections: {
      b2b,
      b2cl,
      b2cs: [...b2cs.values()]
        .sort((a, b) => a.place.localeCompare(b.place) || a.rate - b.rate)
        .map((row) => ['OE', placeOfSupply(row.place), '', row.rate, money(row.taxable), '0.00', '']),
      'hsn-b2b': hsnRows(hsn['hsn-b2b']),
      'hsn-b2c': hsnRows(hsn['hsn-b2c']),
      nil: [...nil].map(([label, amount]) => [label, money(amount), '0.00', '0.00']),
      cdnr,
      cdnur,
      docs: [
        ...documentSeries(
          forGstin.filter((doc) => !doc.debitNoteFor),
          'Invoices for outward supply',
        ),
        ...documentSeries(
          forGstin.filter((doc) => doc.debitNoteFor),
          'Debit Note',
        ),
        ...documentSeries(notes, 'Credit Note'),
      ],
    },
  };
}

/** CSV download for one section: { filename, lines }. */
export function gstr1Csv(report, section) {
  const definition = GSTR1_SECTIONS[section];
  if (!definition) throw new HttpError(404, 'This GSTR-1 section is unavailable.');
  return {
    filename: `GSTR1-${report.gstin || 'no-gstin'}-${report.month}-${section}.csv`,
    lines: ['﻿' + csvRow(definition.columns), ...report.sections[section].map((row) => csvRow(row))],
  };
}

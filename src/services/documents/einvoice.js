/**
 * E-invoice and e-way bill files for an issued invoice, for the government's offline tools (or a
 * GST Suvidha Provider): the e-invoice JSON in the NIC schema 1.1 and the e-way bill bulk JSON.
 * The IRN, signed QR code and e-way bill number they return are saved on the invoice and printed.
 * shortcut: no direct IRP / e-way bill API (needs GSP credentials); add one when the business has them.
 */

import { STATES, calculateLineAmount, documentRoundingPolicy } from '../../../shared/types.js';
import { UQC, invoiceLines } from '../pages/gstr1.js';

const STATE_NAMES = new Map(STATES);
const portalDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const unitCode = (line) =>
  line.hsn.startsWith('99') ? 'OTH' : (UQC[line.unit] ?? 'OTH-OTHERS').split('-')[0];
// The last 6-digit Indian PIN code in a free-text address.
const pinOf = (address = '') =>
  Number(String(address).match(/\b[1-9]\d{5}\b(?!.*\b[1-9]\d{5}\b)/s)?.[0] ?? 0);

// Address line, place and PIN for the government files; the place is the line holding the PIN, else the state.
function place(party) {
  const lines = String(party.address ?? '')
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const town = (lines.findLast((line) => /\b[1-9]\d{5}\b/.test(line)) ?? '').replace(
    /[-–\s]*\b[1-9]\d{5}\b.*/,
    '',
  );
  return {
    address: lines.join(', ').slice(0, 100) || STATE_NAMES.get(party.stateCode) || '',
    place: (town.length >= 3 ? town : (STATE_NAMES.get(party.stateCode) ?? '')).slice(0, 50),
    pin: pinOf(party.address),
  };
}

/** What stops an e-invoice (or e-way bill) for this invoice, as messages; empty when ready. */
export function einvoiceProblems(doc, { ewayBill = false } = {}) {
  const problems = [];
  if (doc.kind !== 'invoice' || ['draft', 'cancelled'].includes(doc.status))
    problems.push('Only an issued invoice can be reported.');
  if (!doc.organizationSnapshot?.gstin) problems.push('Save the business GSTIN in Settings.');
  if (!ewayBill && !doc.customerSnapshot?.gstin)
    problems.push('E-invoices are for registered (B2B) buyers: the buyer has no GSTIN.');
  if (!pinOf(doc.organizationSnapshot?.address))
    problems.push('Add the 6-digit PIN code to the business address.');
  if (!pinOf(doc.customerSnapshot?.address))
    problems.push("Add the 6-digit PIN code to the buyer's address.");
  if (doc.items.some((item) => !/^\d{4,8}$/.test(String(item.hsn ?? '').trim())))
    problems.push('Every line needs an HSN/SAC code of 4 to 8 digits.');
  if (ewayBill && doc.items.every((item) => String(item.hsn ?? '').startsWith('99')))
    problems.push('E-way bills are for goods; this invoice has only services.');
  return problems;
}

// Invoice lines with the values both files need, reconciled to the saved totals.
function lines(doc) {
  const interstate = doc.placeOfSupply !== doc.organizationSnapshot.stateCode;
  const policy = documentRoundingPolicy(doc);
  return invoiceLines(doc).map((line, index) => {
    const taxable = line.taxable.toNumber();
    const tax = line.tax.toNumber();
    const cgst = interstate ? 0 : line.tax.times(0.5).round().toNumber();
    return {
      ...line,
      interstate,
      quantity: line.quantity || 1,
      gross: Math.max(taxable, round(calculateLineAmount(doc.items[index], policy))),
      taxable,
      igst: interstate ? tax : 0,
      cgst,
      sgst: interstate ? 0 : line.tax.minus(cgst).round().toNumber(),
      total: line.taxable.plus(line.tax).round().toNumber(),
    };
  });
}

/** The e-invoice JSON (NIC schema 1.1) for one issued B2B invoice or debit note. */
export function einvoiceJson(doc) {
  const seller = doc.organizationSnapshot;
  const buyer = doc.customerSnapshot;
  const from = place(seller);
  const to = place(buyer);
  const items = lines(doc);
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: doc.debitNoteFor ? 'DBN' : 'INV', No: doc.number, Dt: portalDate(doc.issueDate) },
    SellerDtls: {
      Gstin: seller.gstin,
      LglNm: seller.legalName || seller.name,
      TrdNm: seller.name,
      Addr1: from.address,
      Loc: from.place,
      Pin: from.pin,
      Stcd: seller.stateCode,
    },
    BuyerDtls: {
      Gstin: buyer.gstin,
      LglNm: buyer.name,
      Pos: doc.placeOfSupply,
      Addr1: to.address,
      Loc: to.place,
      Pin: to.pin,
      Stcd: buyer.stateCode || doc.placeOfSupply,
    },
    ItemList: items.map((line, index) => ({
      SlNo: String(index + 1),
      PrdDesc: line.description.slice(0, 300),
      IsServc: line.hsn.startsWith('99') ? 'Y' : 'N',
      HsnCd: line.hsn,
      Qty: line.quantity,
      Unit: unitCode(line),
      UnitPrice: round(line.gross / line.quantity, 3),
      TotAmt: line.gross,
      Discount: round(line.gross - line.taxable),
      AssAmt: line.taxable,
      GstRt: line.rate,
      IgstAmt: line.igst,
      CgstAmt: line.cgst,
      SgstAmt: line.sgst,
      TotItemVal: line.total,
    })),
    ValDtls: {
      AssVal: doc.totals.taxable,
      CgstVal: doc.totals.cgst,
      SgstVal: doc.totals.sgst,
      IgstVal: doc.totals.igst,
      TotInvVal: doc.totals.total,
    },
  };
}

const TRANSPORT_MODES = { road: 1, rail: 2, air: 3, ship: 4 };

/** The e-way bill bulk-upload JSON for one issued invoice and its transport details. */
export function ewayBillJson(doc, transport) {
  const seller = doc.organizationSnapshot;
  const buyer = doc.customerSnapshot;
  const from = place(seller);
  const to = place(buyer);
  const items = lines(doc);
  return {
    version: '1.0.0621',
    billLists: [
      {
        userGstin: seller.gstin,
        supplyType: 'O',
        subSupplyType: 1,
        subSupplyDesc: '',
        docType: 'INV',
        docNo: doc.number,
        docDate: portalDate(doc.issueDate),
        fromGstin: seller.gstin,
        fromTrdName: seller.name,
        fromAddr1: from.address,
        fromAddr2: '',
        fromPlace: from.place,
        fromPincode: from.pin,
        fromStateCode: Number(seller.stateCode),
        actualFromStateCode: Number(seller.stateCode),
        toGstin: buyer.gstin || 'URP',
        toTrdName: buyer.name,
        toAddr1: to.address,
        toAddr2: '',
        toPlace: to.place,
        toPincode: to.pin,
        toStateCode: Number(doc.placeOfSupply),
        actualToStateCode: Number(buyer.stateCode || doc.placeOfSupply),
        transactionType: 1,
        totalValue: doc.totals.taxable,
        cgstValue: doc.totals.cgst,
        sgstValue: doc.totals.sgst,
        igstValue: doc.totals.igst,
        cessValue: 0,
        cessNonAdvolValue: 0,
        otherValue: 0,
        totInvValue: doc.totals.total,
        transMode: TRANSPORT_MODES[transport.mode],
        transDistance: String(transport.distanceKm),
        transporterName: transport.transporterName,
        transporterId: transport.transporterId,
        transDocNo: '',
        transDocDate: '',
        vehicleNo: transport.vehicleNo,
        vehicleType: transport.vehicleNo ? 'R' : '',
        itemList: items.map((line, index) => ({
          itemNo: index + 1,
          productName: line.description.slice(0, 100),
          productDesc: line.description.slice(0, 100),
          hsnCode: Number(line.hsn),
          quantity: line.quantity,
          qtyUnit: unitCode(line),
          taxableAmount: line.taxable,
          sgstRate: line.interstate ? 0 : line.rate / 2,
          cgstRate: line.interstate ? 0 : line.rate / 2,
          igstRate: line.interstate ? line.rate : 0,
          cessRate: 0,
          cessNonAdvol: 0,
        })),
      },
    ],
  };
}

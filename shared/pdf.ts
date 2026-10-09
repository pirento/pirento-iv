import type {
  Column,
  Content,
  ContentColumns,
  ContentStack,
  ContentTable,
  ContentText,
  TDocumentDefinitions,
  TableCell,
} from 'pdfmake/interfaces';
import {
  balanceDue,
  calculateLineAmount,
  getDocumentBranding,
  getDocumentFormat,
  installmentBalances,
  linePriceBreakdown,
  money,
  paidAmount,
  pricingDescription,
  STATES,
  STATUS_LABELS,
  DOCUMENT_LABELS,
} from './types';
import type { BusinessDocument, InvoiceFormat, LineItem } from './types';
import { isIndependentBusiness, organizationSupportEmail } from './business-identity';

const smallWords = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const tensWords = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function integerWords(value: bigint): string {
  if (value < 20n) return smallWords[Number(value)];
  if (value < 100n)
    return `${tensWords[Number(value / 10n)]}${value % 10n ? ` ${integerWords(value % 10n)}` : ''}`;
  for (const [size, label] of [
    [10000000n, 'Crore'],
    [100000n, 'Lakh'],
    [1000n, 'Thousand'],
    [100n, 'Hundred'],
  ] as const) {
    if (value >= size)
      return `${integerWords(value / size)} ${label}${value % size ? ` ${integerWords(value % size)}` : ''}`;
  }
  return '';
}

/** Uses the same two-decimal amount shown on the document, including a paise carry. */
export function amountInWords(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0 || amount >= 1e21) return 'Amount unavailable';
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  const [rupees, paise] = rounded.toFixed(2).split('.');
  return `Rupees ${integerWords(BigInt(rupees))}${Number(paise) ? ` and ${integerWords(BigInt(paise))} Paise` : ''} Only`;
}

export function documentDate(value: string): string {
  if (!value) return '—';
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      })
    : '—';
}

export const stateName = (code: string) => STATES.find(([value]) => value === code)?.[1] ?? code;

export function documentColors(value: string) {
  const accent = /^#[\da-f]{6}$/i.test(value) ? value : '#26705b';
  const rgb = [1, 3, 5].map((index) => parseInt(accent.slice(index, index + 2), 16));
  const luminance = (channels: number[]) =>
    channels
      .map((channel) => channel / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const light = luminance(rgb);
  const onAccent = (light + 0.05) / 0.05 > 1.05 / (light + 0.05) ? '#000000' : '#ffffff';
  let textRgb = rgb;
  while (1.05 / (luminance(textRgb) + 0.05) < 4.5)
    textRgb = textRgb.map((channel) => Math.floor(channel * 0.85));
  return {
    accent,
    onAccent,
    accentText: `#${textRgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`,
  };
}

export function pdfFileName(doc: BusinessDocument): string {
  const stem = `${doc.number} - ${doc.organizationSnapshot.name}`
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._-]/gu, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 160);
  return `${stem || doc.kind}.pdf`;
}

// Break exceptionally long references without truncating customer-entered text.
const printable = (value: string) =>
  value.replace(/\S{35,}/gu, (word) => word.match(/.{1,24}/gu)?.join('\u200b') ?? word);
const text = (value: string, extra: Partial<ContentText> = {}): ContentText => ({
  text: printable(value),
  ...extra,
});
const heading = (value: string): ContentText => text(value.toUpperCase(), { style: 'eyebrow' });

export interface PdfImages {
  logo?: string;
  signature?: string;
  secondarySignature?: string;
  stamp?: string;
  paymentQr?: string;
}
const PNG_JPEG = /^data:image\/(png|jpe?g);base64,/i;
const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback;
export function documentGeometry(format: InvoiceFormat) {
  const pageSize: 'A4' | 'A5' | 'LETTER' =
    format.pageSize === 'A5' || format.pageSize === 'LETTER' ? format.pageSize : 'A4';
  const orientation: 'portrait' | 'landscape' = format.orientation === 'landscape' ? 'landscape' : 'portrait';
  const sizes = { A4: [210, 297], A5: [148, 210], LETTER: [215.9, 279.4] };
  const [short, long] = sizes[pageSize];
  return {
    pageSize,
    orientation,
    widthMm: orientation === 'landscape' ? long : short,
    heightMm: orientation === 'landscape' ? short : long,
    fontSize: clamp(format.fontSize, 9, 8, 14),
    marginMm: clamp(format.pageMargin, 14, 8, 24),
    logoWidth: clamp(format.logoWidth, 72, 32, 140),
    signatureWidth: clamp(format.signatureWidth, 140, 70, 220),
    paymentQrWidth: clamp(format.paymentQrWidth, 110, 70, 160),
    stampWidth: clamp(format.stampWidth, 110, 60, 180),
  };
}
export function documentLogo(doc: BusinessDocument): string {
  const branding = getDocumentBranding(doc);
  if (branding.logoMode === 'none') return '';
  if (branding.logoMode === 'custom') return branding.logoUrl;
  return (
    getDocumentFormat(doc).logoUrl ||
    doc.businessProductSnapshot?.logoUrl ||
    doc.organizationSnapshot.logoUrl ||
    ''
  );
}
export interface SigningBlock {
  key: 'signature' | 'secondarySignature' | 'stamp';
  label: string;
  imageUrl: string;
  width: number;
}
export function documentSigningBlocks(doc: BusinessDocument): SigningBlock[] {
  const branding = getDocumentBranding(doc);
  const format = getDocumentFormat(doc);
  const geometry = documentGeometry(format);
  const blocks: SigningBlock[] = [];
  if (format.showSignature)
    blocks.push({
      key: 'signature',
      label: branding.primarySignatureLabel || 'Authorised Signatory',
      imageUrl: branding.primarySignatureImageUrl,
      width: geometry.signatureWidth,
    });
  if (format.showSecondarySignature && branding.showSecondarySignature)
    blocks.push({
      key: 'secondarySignature',
      label: branding.secondarySignatureLabel || 'Secondary authorised signatory',
      imageUrl: branding.secondarySignatureImageUrl,
      width: geometry.signatureWidth,
    });
  if (format.showStamp && branding.showStamp)
    blocks.push({
      key: 'stamp',
      label: branding.stampLabel || 'Company stamp',
      imageUrl: branding.stampImageUrl,
      width: geometry.stampWidth,
    });
  return blocks;
}
export function linePricingNote(doc: BusinessDocument, item: LineItem): string {
  if (doc.kind !== 'delivery_note') return pricingDescription(item);
  const jewellery = item.pricing?.mode === 'jewellery' ? item.pricing.jewellery : undefined;
  if (!jewellery) return '';
  return [
    jewellery.purity,
    `Per item: gross ${jewellery.grossWeight} g, stone ${jewellery.stoneWeight} g, net ${Number(linePriceBreakdown(item).netWeight.toFixed(6))} g`,
  ]
    .filter(Boolean)
    .join(' · ');
}
export const INSTALLMENT_STATUS_LABELS = {
  paid: 'Paid',
  partially_paid: 'Partially paid',
  overdue: 'Overdue',
  pending: 'Pending',
} as const;

/** The seller identity always comes from the document's saved organization. */
export function documentBusinessIdentity(doc: BusinessDocument) {
  const org = doc.organizationSnapshot;
  const tradeName = org.tradeName?.trim() || '';
  const legalName = org.legalName.trim() || tradeName || org.name;
  const independent = isIndependentBusiness(org);
  const legalLabel = independent
    ? /proprietor/i.test(org.businessConstitution || '')
      ? 'Proprietor'
      : 'Legal name'
    : 'A division of';
  return {
    tradeName: tradeName !== org.name ? tradeName : '',
    legalName,
    legalLabel,
    showLegalName: legalName !== org.name && legalName !== tradeName,
    sellerName: independent && tradeName ? tradeName : legalName,
    sellerLegalName: independent && tradeName && tradeName !== legalName ? `${legalLabel}: ${legalName}` : '',
    signoffName: independent && tradeName ? tradeName : legalName,
    supportEmail: organizationSupportEmail(org),
  };
}

export const documentTitle = (doc: BusinessDocument) =>
  doc.kind === 'invoice'
    ? doc.organizationSnapshot.gstin
      ? 'TAX INVOICE'
      : 'INVOICE'
    : doc.kind === 'proforma'
      ? 'PROFORMA INVOICE'
      : doc.kind === 'delivery_note'
        ? 'DELIVERY CHALLAN'
        : 'QUOTATION';
export const documentDueDate = (doc: BusinessDocument) =>
  doc.installmentPlan?.installments.length
    ? [...doc.installmentPlan.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).at(-1)!.dueDate
    : doc.dueDate;
export const documentDueLabel = (doc: BusinessDocument) =>
  doc.installmentPlan?.installments.length
    ? 'Final installment'
    : doc.kind === 'invoice'
      ? 'Due date'
      : doc.kind === 'delivery_note'
        ? 'Expected delivery'
        : 'Valid until';
export const documentSubject = (doc: BusinessDocument) => {
  const title = doc.title.trim();
  const normalized = title.toLowerCase().replace(/[_\s-]+/g, ' ');
  const defaults = [
    DOCUMENT_LABELS[doc.kind],
    documentTitle(doc),
    doc.kind === 'delivery_note' ? 'Delivery note' : '',
  ].map((value) => value.toLowerCase());
  return defaults.includes(normalized) ? '' : title;
};
export function shippingGroups(doc: BusinessDocument): [string, string][][] {
  const fields = shippingDetails(doc);
  return [
    fields.filter(([key]) => ['Recipient', 'Address', 'State', 'Phone'].includes(key)),
    fields.filter(([key]) => !['Recipient', 'Address', 'State', 'Phone'].includes(key)),
  ].filter((group) => group.length);
}
export function bankDetails(doc: BusinessDocument): [string, string][] {
  const org = doc.organizationSnapshot;
  return (
    [
      ['Bank', org.bankName],
      ['Branch', org.bankBranch || ''],
      ['Account name', org.accountName],
      ['Account no.', org.accountNumber],
      ['Account type', org.accountType || ''],
      ['IFSC', org.ifsc],
    ] as [string, string][]
  ).filter(([, value]) => value);
}
export function shippingDetails(doc: BusinessDocument): [string, string][] {
  const shipping = doc.shipping;
  if (!shipping) return [];
  return (
    [
      ['Recipient', shipping.recipientName],
      ['Address', shipping.address],
      ['State', shipping.stateCode ? `${stateName(shipping.stateCode)} (${shipping.stateCode})` : ''],
      ['Phone', shipping.phone],
      ['Carrier', shipping.carrier],
      ['Tracking no.', shipping.trackingNumber],
      ['Vehicle no.', shipping.vehicleNumber],
      ['Dispatch date', shipping.dispatchDate ? documentDate(shipping.dispatchDate) : ''],
      ['Delivery date', shipping.deliveryDate ? documentDate(shipping.deliveryDate) : ''],
      ['Reference', shipping.reference],
      ['Shipping notes', shipping.notes],
    ] as [string, string][]
  ).filter(([, value]) => value);
}

/** Uses saved document snapshots; PNG/JPEG source bytes are embedded unchanged. */
export function buildDocumentDefinition(
  doc: BusinessDocument,
  imageInput?: PdfImages | string,
): TDocumentDefinitions {
  const org = doc.organizationSnapshot;
  const identity = documentBusinessIdentity(doc);
  const customer = doc.customerSnapshot;
  const format = getDocumentFormat(doc);
  const geometry = documentGeometry(format);
  const signingBlocks = documentSigningBlocks(doc);
  const { fontSize } = geometry;
  const colors = documentColors(format.accentColor);
  const compact = format.density === 'compact';
  const classic = format.layout === 'classic';
  const minimal = format.layout === 'minimal';
  const ledger = format.layout === 'ledger';
  const sidebar = format.layout === 'sidebar';
  const delivery = doc.kind === 'delivery_note';
  const invoice = doc.kind === 'invoice';
  const mm = 72 / 25.4;
  const margin = geometry.marginMm * mm;
  const pageWidth = geometry.widthMm * mm;
  const pageHeight = geometry.heightMm * mm;
  const contentWidth = pageWidth - 2 * margin;
  const narrow = contentWidth < 390;
  const gap = narrow ? 10 : 14;
  const content: Content[] = [];
  const original = (value?: string) => (value && PNG_JPEG.test(value) ? value : undefined);
  const sourceImages: PdfImages =
    typeof imageInput === 'string'
      ? { logo: imageInput }
      : (imageInput ?? {
          logo: original(documentLogo(doc)),
          paymentQr: original(org.paymentQrUrl),
          ...Object.fromEntries(signingBlocks.map((block) => [block.key, original(block.imageUrl)])),
        });
  const images: Record<string, string> = {};
  if (format.showLogo && sourceImages.logo) images.brandLogo = sourceImages.logo;
  for (const block of signingBlocks) {
    const data = sourceImages[block.key];
    if (data) images[`${block.key}Image`] = data;
  }
  if (!delivery && format.showPaymentQr && sourceImages.paymentQr) images.paymentQr = sourceImages.paymentQr;
  const labelColor = minimal || classic || ledger ? colors.accentText : colors.onAccent;
  const small = Math.max(7, fontSize - 1);
  const title = documentTitle(doc);
  const status = `${STATUS_LABELS[doc.status] || doc.status}${doc.finalizedAt ? ' · Final' : ''}`;
  const brandStack: Content[] = [text(org.name, { style: 'brand' })];
  if (identity.tradeName)
    brandStack.push(text(`Trade name: ${identity.tradeName}`, { fontSize: small, margin: [0, 3, 0, 2] }));
  if (doc.businessProductSnapshot?.name)
    brandStack.push(
      text(`Product: ${doc.businessProductSnapshot.name}`, {
        bold: true,
        color: colors.accentText,
        margin: [0, 4, 0, 2],
      }),
    );
  if (identity.showLegalName)
    brandStack.push(
      text(identity.legalLabel, { fontSize: small, color: '#647067', margin: [0, 3, 0, 2] }),
      text(identity.legalName),
    );
  const logoWidth = geometry.logoWidth * 0.75;
  const logoHeight = Math.min(72, Math.max(32, logoWidth));
  const brand: ContentColumns | ContentStack = images.brandLogo
    ? narrow
      ? {
          stack: [
            {
              image: 'brandLogo',
              fit: [logoWidth, logoHeight],
              alignment: classic ? 'center' : 'left',
              margin: [0, 0, 0, 8],
            },
            ...brandStack,
          ],
        }
      : {
          columns: [
            { image: 'brandLogo', fit: [logoWidth, logoHeight], width: logoWidth },
            { stack: brandStack },
          ],
          columnGap: 10,
        }
    : { stack: brandStack };
  if (classic && !narrow && images.brandLogo) {
    Object.assign(brand, {
      columns: [
        { image: 'brandLogo', fit: [logoWidth, logoHeight], width: logoWidth },
        { stack: brandStack, alignment: 'center' },
        { text: '', width: logoWidth },
      ],
      columnGap: 10,
    });
  }
  const label: ContentStack = {
    stack: [
      text(title, { style: 'title' }),
      text(doc.number, { bold: true, margin: [0, 4, 0, 4] }),
      text(status.toUpperCase(), { fontSize: small, color: '#52665a' }),
    ],
    alignment: classic ? 'center' : narrow ? 'left' : 'right',
  };
  if (classic && !narrow)
    content.push({
      stack: [
        { ...brand, alignment: 'center' },
        {
          columns: [
            text(title, { style: 'title' }),
            {
              stack: [
                text(doc.number, { bold: true }),
                text(status.toUpperCase(), { fontSize: small, color: '#52665a', margin: [0, 3, 0, 0] }),
              ],
              alignment: 'right',
              width: contentWidth * 0.35,
            },
          ],
          columnGap: gap,
          margin: [0, 10, 0, 0],
        },
      ],
      margin: [0, 0, 0, 10],
    });
  else if (classic)
    content.push({
      stack: [
        { ...brand, alignment: 'center' },
        { ...label, margin: [0, 10, 0, 0] },
      ],
      margin: [0, 0, 0, 10],
    });
  else if (narrow)
    content.push({ stack: [brand, { ...label, margin: [0, 10, 0, 0] }], margin: [0, 0, 0, 10] });
  else
    content.push({
      columns: [
        { ...brand, width: '*' },
        { ...label, width: contentWidth * (ledger ? 0.38 : 0.32) },
      ],
      columnGap: gap,
      margin: [0, 0, 0, 10],
    });
  content.push({
    canvas: [
      {
        type: 'line',
        x1: 0,
        y1: 0,
        x2: contentWidth,
        y2: 0,
        lineWidth: minimal ? 0.5 : classic || ledger ? 1.5 : 3,
        lineColor: minimal ? '#c9d3cc' : colors.accent,
      },
    ],
    margin: [0, 0, 0, 10],
  });

  const seller: Content[] = [heading('From'), text(identity.sellerName, { bold: true })];
  if (identity.sellerLegalName) seller.push(text(identity.sellerLegalName, { fontSize: small }));
  if (org.address) seller.push(text(org.address));
  if (org.stateCode) seller.push(text(`${stateName(org.stateCode)} · State code ${org.stateCode}`));
  if (org.gstin) seller.push(text(`GSTIN: ${org.gstin}`, { bold: true, fontSize: small }));
  if (org.pan) seller.push(text(`PAN: ${org.pan}`, { fontSize: small }));
  if (org.cin) seller.push(text(`CIN: ${org.cin}`, { fontSize: small }));
  if (org.email) seller.push(text(org.email));
  if (org.phone) seller.push(text(org.phone));
  const buyer: Content[] = [heading(delivery ? 'Customer' : 'Bill to'), text(customer.name, { bold: true })];
  if (customer.contactPerson) buyer.push(text(`Attn: ${customer.contactPerson}`));
  if (customer.address) buyer.push(text(customer.address));
  if (customer.stateCode)
    buyer.push(text(`${stateName(customer.stateCode)} · State code ${customer.stateCode}`));
  if (customer.gstin) buyer.push(text(`GSTIN: ${customer.gstin}`, { bold: true, fontSize: small }));
  if (customer.email) buyer.push(text(customer.email));
  if (customer.phone) buyer.push(text(customer.phone));
  const dates: Content[] = [heading('Issue date'), text(documentDate(doc.issueDate))];
  if (documentDueDate(doc))
    dates.push(
      { ...heading(documentDueLabel(doc)), margin: [0, 8, 0, 4] },
      text(documentDate(documentDueDate(doc))),
    );
  if (doc.placeOfSupply)
    dates.push(
      { ...heading('Place of supply'), margin: [0, 8, 0, 4] },
      text(`${stateName(doc.placeOfSupply)} (${doc.placeOfSupply})`),
    );
  if (narrow) {
    content.push({
      columns: [
        { stack: seller, width: '*' },
        { stack: buyer, width: '*' },
      ],
      columnGap: gap,
      margin: [0, 0, 0, 10],
    });
    content.push({ stack: dates, margin: [0, 0, 0, 10] });
  } else
    content.push({
      columns: [
        { stack: seller, width: '*' },
        { stack: buyer, width: '*' },
        { stack: dates, width: contentWidth * 0.21 },
      ],
      columnGap: gap,
      margin: [0, 0, 0, 10],
    });

  const sectionTable = (label: string, rows: Content[]): ContentTable & { width: '*' } => ({
    unbreakable: JSON.stringify(rows).length < 1800,
    table: { headerRows: 1, widths: ['*'], body: [[heading(label)], ...rows.map((row) => [row])] },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 1.5,
      paddingLeft: () => 0,
      paddingRight: () => 0,
    },
    width: '*',
  });
  const shipping = shippingDetails(doc);
  if (shipping.length) {
    const groups = shippingGroups(doc).map((group) => ({
      stack: group.map(([key, value]) => text(`${key}: ${value}`)),
      width: '*' as const,
    }));
    content.push({
      stack: [heading('Shipping details'), { columns: groups, columnGap: gap }],
      margin: [0, 0, 0, 10],
      unbreakable: shipping.reduce((size, [, value]) => size + value.length, 0) < 600,
    });
  }
  const subject = documentSubject(doc);
  if (subject)
    content.push({
      stack: [heading('Subject'), text(subject, { bold: true, fontSize: fontSize + 1 })],
      margin: [0, 0, 0, 10],
      unbreakable: subject.length < 500,
    });
  if (doc.kind === 'proforma')
    content.push(
      text('Proforma invoice — not a tax invoice.', {
        italics: true,
        color: colors.accentText,
        margin: [0, 0, 0, 12],
      }),
    );

  const columnNames = [
    '#',
    'Description',
    ...(format.showHsn ? ['HSN / SAC'] : []),
    'Qty',
    ...(format.showUnit ? ['Unit'] : []),
    ...(!delivery ? ['Rate', ...(format.showGstRate ? ['GST'] : []), 'Amount'] : []),
  ];
  const weights = [
    4,
    delivery ? 60 : 31,
    ...(format.showHsn ? [11] : []),
    7,
    ...(format.showUnit ? [8] : []),
    ...(!delivery ? [15, ...(format.showGstRate ? [8] : []), 19] : []),
  ];
  const padding = narrow ? 2 : 4;
  const lineWidth = ledger && format.tableStyle !== 'plain' ? 0.5 : 0;
  const available = contentWidth - columnNames.length * padding * 2 - (columnNames.length + 1) * lineWidth;
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const widths = weights.map((weight) => (available * weight) / totalWeight);
  const rowCell = (value: string, right = false, bold = false): TableCell => ({
    text: printable(value),
    alignment: right ? 'right' : 'left',
    bold,
    fontSize,
  });
  const body: TableCell[][] = [
    columnNames.map((name) => ({
      text: name,
      bold: true,
      color: labelColor,
      fillColor: minimal ? '#ffffff' : classic || ledger ? '#f2f5f0' : colors.accent,
      fontSize: small,
      alignment: ['Qty', 'Rate', 'GST', 'Amount'].includes(name) ? 'right' : 'left',
    })),
  ];
  const detailRows = new Set<number>();
  doc.items.forEach((item, index) => {
    body.push([
      rowCell(String(index + 1)),
      rowCell(item.description),
      ...(format.showHsn ? [rowCell(item.hsn || '—')] : []),
      rowCell(String(item.quantity), true),
      ...(format.showUnit ? [rowCell(item.unit || '—')] : []),
      ...(!delivery
        ? [
            rowCell(money(item.rate), true),
            ...(format.showGstRate ? [rowCell(`${item.gstRate}%`, true)] : []),
            rowCell(money(calculateLineAmount(item)), true, true),
          ]
        : []),
    ]);
    const detail = linePricingNote(doc, item);
    if (detail) {
      detailRows.add(body.length);
      body.push([
        '',
        { text: printable(detail), colSpan: columnNames.length - 1, fontSize, color: '#52665a' },
        ...Array.from({ length: columnNames.length - 2 }, () => ({})),
      ]);
    }
  });
  const itemsTable: ContentTable = {
    table: { headerRows: 1, widths, body },
    layout: {
      hLineWidth: (index) =>
        detailRows.has(index) ? 0 : format.tableStyle === 'plain' ? (index === 1 ? 0.5 : 0) : 0.5,
      vLineWidth: () => lineWidth,
      hLineColor: () => '#d4ddd5',
      vLineColor: () => '#d4ddd5',
      fillColor: (index) =>
        index > 0 && format.tableStyle === 'striped' && index % 2 === 0 ? '#f3f6f2' : null,
      paddingLeft: () => padding,
      paddingRight: () => padding,
      paddingTop: (index) => (detailRows.has(index) ? 0 : compact ? 4 : 6),
      paddingBottom: () => (compact ? 4 : 6),
    },
    margin: [0, 0, 0, 10],
  };
  content.push(itemsTable);

  const note: Content[] = [];
  if (doc.notes) note.push(heading('Notes'), text(doc.notes));
  if (doc.kind === 'quotation')
    note.push(
      text('This quotation is an estimate of the services and prices listed above.', {
        italics: true,
        fontSize: small,
        color: '#647067',
        margin: [0, 8, 0, 0],
      }),
    );
  if (!delivery && format.showAmountInWords)
    note.push(
      { ...heading('Amount in words'), margin: [0, 8, 0, 4] },
      text(amountInWords(doc.totals.total), { bold: true }),
    );
  if (delivery) {
    if (note.length) content.push({ stack: note, margin: [0, 0, 0, 10] });
  } else {
    const totals: TableCell[][] = [];
    const totalRow = (label: string, value: number, bold = false) =>
      totals.push([
        { text: label, color: '#52665a', bold },
        { text: money(value), alignment: 'right', bold },
      ]);
    totalRow('Subtotal', doc.totals.subtotal);
    if (doc.totals.discount > 0) totalRow(`Discount (${doc.discountPercent}%)`, -doc.totals.discount);
    totalRow('Taxable amount', doc.totals.taxable);
    if (doc.totals.cgst > 0) totalRow('CGST', doc.totals.cgst);
    if (doc.totals.sgst > 0) totalRow('SGST / UTGST', doc.totals.sgst);
    if (doc.totals.igst > 0) totalRow('IGST', doc.totals.igst);
    const grandIndex = totals.length;
    totals.push([
      {
        text: 'Total INR',
        bold: true,
        fontSize: fontSize + 1,
        color: colors.accentText,
        margin: [0, 3, 0, 3],
      },
      {
        text: money(doc.totals.total),
        bold: true,
        fontSize: fontSize + 2,
        color: colors.accentText,
        alignment: 'right',
        margin: [0, 3, 0, 3],
      },
    ]);
    if (invoice) {
      totalRow('Amount received', paidAmount(doc));
      totalRow('Balance due', balanceDue(doc), true);
    }
    const totalContent: Column = {
      table: { widths: ['*', 'auto'], body: totals, dontBreakRows: true },
      layout: {
        hLineWidth: (index) => (index === grandIndex ? 1 : 0),
        vLineWidth: () => 0,
        hLineColor: () => (minimal ? '#c9d3cc' : colors.accent),
        paddingTop: () => 2,
        paddingBottom: () => 2,
        paddingLeft: () => 4,
        paddingRight: () => 4,
        fillColor: (index) => (index === grandIndex && !minimal && !classic ? '#f3f6f0' : null),
      },
      width: narrow ? '*' : Math.max(225, contentWidth * 0.45),
    };
    if (narrow)
      content.push({
        stack: [...note, { ...totalContent, margin: [0, note.length ? 16 : 0, 0, 0] }],
        margin: [0, 0, 0, 10],
      });
    else
      content.push({
        columns: [{ stack: note.length ? note : [''], width: '*' }, totalContent],
        columnGap: gap,
        margin: [0, 0, 0, 10],
      });
  }

  const installments = delivery ? [] : installmentBalances(doc);
  if (installments.length) {
    const planColumns = ['Installment', 'Due date', 'Amount', 'Received', 'Pending', 'Status'];
    const planWeights = [25, 18, 17, 17, 17, 18];
    const planAvailable = contentWidth - planColumns.length * padding * 2;
    const planBody: TableCell[][] = [
      [
        {
          stack: [
            heading('Payment schedule / EMI'),
            text(doc.installmentPlan?.name || 'Payment schedule', { bold: true }),
          ],
          colSpan: 6,
          margin: [0, 0, 0, 5],
        },
        {},
        {},
        {},
        {},
        {},
      ],
      planColumns.map((name, index) => ({
        text: name,
        bold: true,
        fontSize: small,
        color: colors.accentText,
        fillColor: '#f2f5f0',
        alignment: index >= 2 && index <= 4 ? 'right' : 'left',
      })),
      ...installments.map((entry) => [
        rowCell(entry.label),
        rowCell(documentDate(entry.dueDate)),
        rowCell(money(entry.amount), true),
        rowCell(money(entry.amountPaid), true),
        rowCell(money(entry.balanceDue), true),
        rowCell(INSTALLMENT_STATUS_LABELS[entry.status]),
      ]),
    ];
    content.push({
      table: {
        headerRows: 2,
        widths: planWeights.map((weight) => (planAvailable * weight) / 112),
        body: planBody,
      },
      layout: {
        hLineWidth: (index) => (index <= 1 ? 0 : 0.5),
        vLineWidth: () => 0,
        hLineColor: () => '#d4ddd5',
        paddingLeft: () => padding,
        paddingRight: () => padding,
        paddingTop: () => (compact ? 4 : 6),
        paddingBottom: () => (compact ? 4 : 6),
      },
      margin: [0, 0, 0, 12],
    });
  }

  const bottom: ((ContentTable | ContentStack) & { width: '*' | number })[] = [];
  if (!delivery && format.showBankDetails && bankDetails(doc).length)
    bottom.push(
      sectionTable(
        'Bank details',
        bankDetails(doc).map(([key, value]) => text(`${key}: ${value}`)),
      ),
    );
  if (doc.terms) bottom.push(sectionTable('Terms & conditions', [text(doc.terms)]));
  if (images.paymentQr)
    bottom.push({
      stack: [
        heading('Scan to pay'),
        { image: 'paymentQr', fit: [geometry.paymentQrWidth * 0.75, geometry.paymentQrWidth * 0.75] },
      ],
      width: geometry.paymentQrWidth * 0.75,
      unbreakable: true,
    });
  if (bottom.length)
    content.push(
      narrow
        ? { stack: bottom.map((section) => ({ ...section, margin: [0, 0, 0, 10] }) as Content) }
        : { columns: bottom, columnGap: gap, margin: [0, 0, 0, 10] },
    );
  const message: Content[] = [];
  if (format.footerText) message.push(text(format.footerText, { color: colors.accentText }));
  message.push(
    text(identity.supportEmail ? `Support: ${identity.supportEmail}` : org.name, {
      fontSize: small,
      margin: [0, 3, 0, 0],
    }),
  );
  content.push({
    columns: [
      { stack: message, width: '*' },
      ...(signingBlocks.length
        ? [
            {
              text: printable(`For ${identity.signoffName}`),
              alignment: 'right' as const,
              fontSize: small,
              width: contentWidth * 0.5,
            },
          ]
        : []),
    ],
    columnGap: gap,
    margin: [0, 0, 0, 8],
  });
  if (signingBlocks.length) {
    const columnsPerRow = narrow ? 2 : 3;
    for (let offset = 0; offset < signingBlocks.length; offset += columnsPerRow) {
      const blocks = signingBlocks.slice(offset, offset + columnsPerRow);
      const cellWidth = (contentWidth - gap * (blocks.length - 1)) / blocks.length;
      const frameHeight = Math.max(
        44,
        ...blocks.map((block) =>
          Math.min(
            block.key === 'stamp' && images[`${block.key}Image`] ? block.width * 0.75 : 54,
            cellWidth - 12,
          ),
        ),
      );
      const estimatedHeight =
        frameHeight +
        Math.max(
          ...blocks.map(
            (block) => Math.ceil((block.label.length * small * 0.55) / (cellWidth - 12)) * small * 1.3,
          ),
        ) +
        14;
      const cells: Column[] = blocks.map((block) => ({
        stack: [
          {
            table: {
              widths: [cellWidth - 12],
              heights: [frameHeight],
              body: [
                [
                  images[`${block.key}Image`]
                    ? {
                        image: `${block.key}Image`,
                        fit: [Math.min(block.width * 0.75, cellWidth - 16), frameHeight - 8],
                        alignment: 'center',
                        margin: [0, 4, 0, 4],
                      }
                    : { text: '' },
                ],
              ],
            },
            layout: {
              hLineWidth: () => 0.5,
              vLineWidth: () => 0.5,
              hLineColor: () => '#cbd5cd',
              vLineColor: () => '#cbd5cd',
              paddingLeft: () => 5,
              paddingRight: () => 5,
              paddingTop: () => 0,
              paddingBottom: () => 0,
            },
          },
          text(block.label, { alignment: 'center', fontSize: small, margin: [0, 5, 0, 0] }),
        ],
        width: cellWidth,
      }));
      content.push({
        columns: cells,
        columnGap: gap,
        margin: [0, 0, 0, offset + columnsPerRow < signingBlocks.length ? 10 : 0],
        unbreakable: estimatedHeight < pageHeight - margin - Math.max(margin, 30),
      });
    }
  }

  return {
    pageSize: geometry.pageSize,
    pageOrientation: geometry.orientation,
    pageMargins: [margin, margin, margin, Math.max(margin, 30)],
    info: {
      title: `${doc.number} — ${org.name}`,
      author: identity.legalName,
      subject: doc.title || title,
      creator: 'Business workspace',
    },
    defaultStyle: { font: 'Roboto', fontSize, color: '#33473c', lineHeight: compact ? 1.05 : 1.1 },
    styles: {
      brand: { fontSize: fontSize + (minimal ? 9 : 11), bold: !minimal, color: colors.accentText },
      title: {
        fontSize: fontSize + (classic ? 9 : minimal ? 6 : 8),
        bold: classic || ledger,
        color: colors.accentText,
      },
      eyebrow: { fontSize: small, bold: true, color: '#647067', characterSpacing: 0.5, margin: [0, 0, 0, 5] },
    },
    images,
    content,
    ...(sidebar
      ? {
          background: {
            canvas: [
              {
                type: 'rect' as const,
                x: margin - 12,
                y: margin,
                w: 4,
                h: pageHeight - 2 * margin,
                color: colors.accent,
              },
            ],
          },
        }
      : {}),
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: printable(identity.signoffName), width: '*' },
        { text: `${doc.number} · ${currentPage} / ${pageCount}`, alignment: 'right', width: 'auto' },
      ],
      columnGap: 12,
      fontSize: 7,
      color: '#647067',
      margin: [margin, 6, margin, 0],
    }),
  };
}

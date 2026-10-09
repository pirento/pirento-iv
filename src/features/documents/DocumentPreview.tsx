import { downloadDocumentPdf } from './browser-pdf';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ArrowLeft,
  ArrowRightLeft,
  CreditCard,
  Download,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Pencil,
  Printer,
  Truck,
} from 'lucide-react';
import {
  balanceDue,
  calculateLineAmount,
  DOCUMENT_LABELS,
  getDocumentFormat,
  installmentBalances,
  money,
  paidAmount,
  STATUS_LABELS,
} from '../../../shared/types';
import type { BusinessDocument } from '../../../shared/types';
import {
  amountInWords,
  bankDetails,
  documentBusinessIdentity,
  documentColors,
  documentDate as date,
  documentDueDate,
  documentDueLabel,
  documentGeometry,
  documentLogo,
  documentSigningBlocks,
  documentSubject,
  documentTitle,
  INSTALLMENT_STATUS_LABELS,
  linePricingNote,
  shippingDetails,
  shippingGroups,
  stateName,
} from '../../../shared/pdf';
import './documents.css';

interface Props {
  document: BusinessDocument;
  onClose: () => void;
  onEdit: () => void;
  onConvert?: () => Promise<void>;
  onPayments?: () => void;
  onEmail?: () => void;
  onCreateDeliveryNote?: () => Promise<void>;
}

export default function DocumentPreview({
  document: doc,
  onClose,
  onEdit,
  onConvert,
  onPayments,
  onCreateDeliveryNote,
  onEmail,
}: Props) {
  const organization = doc.organizationSnapshot;
  const customer = doc.customerSnapshot;
  const identity = documentBusinessIdentity(doc);
  const { totals } = doc;
  const format = getDocumentFormat(doc);
  const geometry = documentGeometry(format);
  const colors = documentColors(format.accentColor);
  const signingBlocks = documentSigningBlocks(doc);
  const installments = doc.kind === 'delivery_note' ? [] : installmentBalances(doc);
  const style = {
    '--doc-accent': colors.accent,
    '--doc-on-accent': colors.onAccent,
    '--doc-accent-text': colors.accentText,
    '--doc-page-width': `${geometry.widthMm}mm`,
    '--doc-page-height': `${geometry.heightMm}mm`,
    '--doc-margin': `${geometry.marginMm}mm`,
    '--doc-font-size': `${geometry.fontSize}pt`,
    '--doc-logo-width': `${geometry.logoWidth}px`,
    '--doc-signature-width': `${geometry.signatureWidth}px`,
    '--doc-stamp-width': `${geometry.stampWidth}px`,
    '--doc-qr-width': `${geometry.paymentQrWidth}px`,
    '--doc-logo-height': `${Math.min(96, Math.max(42.67, geometry.logoWidth))}px`,
  } as CSSProperties;
  const [converting, setConverting] = useState(false);
  const [creatingDelivery, setCreatingDelivery] = useState(false);
  const deliveryRef = useRef(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [downloadNotice, setDownloadNotice] = useState('');
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const convertingRef = useRef(false);
  const downloadingRef = useRef(false);
  const isInvoice = doc.kind === 'invoice';
  const delivery = doc.kind === 'delivery_note';
  const convertible = doc.kind === 'quotation' || doc.kind === 'proforma';
  const busy = converting || downloading || creatingDelivery;
  const locked = Boolean(doc.finalizedAt || doc.convertedInvoiceId);
  const logo = documentLogo(doc);
  const bank = !delivery && format.showBankDetails ? bankDetails(doc) : [];
  const shipping = shippingDetails(doc);
  const subject = documentSubject(doc);
  const showQr = !delivery && format.showPaymentQr && organization.paymentQrUrl && !imageErrors['payment QR'];
  const narrow = geometry.widthMm - 2 * geometry.marginMm < 137.5;
  const failImage = (label: string) => setImageErrors((previous) => ({ ...previous, [label]: true }));

  useEffect(() => {
    setImageErrors({});
    setDownloadNotice('');
    setError('');
  }, [doc.id, doc.updatedAt]);

  async function convert() {
    if (!onConvert || convertingRef.current) return;
    convertingRef.current = true;
    setConverting(true);
    setError('');
    try {
      await onConvert();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not convert this document. Please try again.');
    } finally {
      convertingRef.current = false;
      setConverting(false);
    }
  }
  async function createDeliveryNote() {
    if (!onCreateDeliveryNote || deliveryRef.current) return;
    deliveryRef.current = true;
    setCreatingDelivery(true);
    setError('');
    try {
      await onCreateDeliveryNote();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not create the delivery challan. Please try again.',
      );
    } finally {
      deliveryRef.current = false;
      setCreatingDelivery(false);
    }
  }
  function print() {
    const oldTitle = window.document.title;
    window.document.title = `${doc.number} — ${organization.name}`;
    try {
      window.print();
    } finally {
      window.document.title = oldTitle;
    }
  }
  async function download() {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    setDownloading(true);
    setError('');
    setDownloadNotice('');
    try {
      const { warning } = await downloadDocumentPdf(doc);
      setDownloadNotice(warning || 'PDF downloaded.');
    } catch {
      setError(
        'The PDF could not be downloaded. Please try again, or use Print to save a copy. Original images must be PNG, JPG or WebP.',
      );
    } finally {
      downloadingRef.current = false;
      setDownloading(false);
    }
  }

  return (
    <section className="workspace-page doc-preview-page doc-preview" aria-labelledby="doc-preview-heading">
      <style>{`@page { size: ${geometry.pageSize === 'LETTER' ? 'letter' : geometry.pageSize} ${geometry.orientation}; margin: ${geometry.marginMm}mm; }`}</style>
      <header className="doc-preview-toolbar">
        <button
          type="button"
          className="doc-button doc-button-secondary doc-page-back"
          onClick={onClose}
          disabled={busy}
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div className="doc-preview-heading">
          <FileText size={19} />
          <div>
            <h1 id="doc-preview-heading">{doc.number}</h1>
            <span>{organization.name}</span>
          </div>
          <span className={`doc-status doc-status-${doc.status}`}>
            {STATUS_LABELS[doc.status] || doc.status}
          </span>
          {doc.finalizedAt && (
            <span className="doc-final-badge">
              <LockKeyhole size={12} /> Final
            </span>
          )}
        </div>
        <div className="doc-preview-actions">
          <button
            type="button"
            className="doc-button doc-button-secondary"
            onClick={onEdit}
            disabled={busy || locked}
            title={
              doc.finalizedAt
                ? 'Finalized documents are locked'
                : doc.convertedInvoiceId
                  ? 'This document has been converted'
                  : undefined
            }
          >
            <Pencil size={15} /> Edit
          </button>
          {convertible &&
            onConvert &&
            !doc.convertedInvoiceId &&
            !['declined', 'cancelled'].includes(doc.status) && (
              <button
                type="button"
                className="doc-button doc-button-secondary"
                onClick={convert}
                disabled={busy}
              >
                {converting ? (
                  <LoaderCircle size={15} className="doc-spinning" />
                ) : (
                  <ArrowRightLeft size={15} />
                )}
                {converting ? 'Converting…' : 'Convert to invoice'}
              </button>
            )}
          {isInvoice && onPayments && (
            <button
              type="button"
              className="doc-button doc-button-secondary"
              onClick={onPayments}
              disabled={busy}
            >
              <CreditCard size={15} /> Payments
            </button>
          )}
          {isInvoice && onCreateDeliveryNote && !doc.deliveryNoteId && doc.status !== 'cancelled' && (
            <button
              type="button"
              className="doc-button doc-button-secondary"
              onClick={createDeliveryNote}
              disabled={busy}
            >
              {creatingDelivery ? <LoaderCircle size={15} className="doc-spinning" /> : <Truck size={15} />}
              {creatingDelivery ? 'Creating…' : 'Delivery challan'}
            </button>
          )}
          {onEmail && (
            <button
              type="button"
              className="doc-button doc-button-secondary"
              onClick={onEmail}
              disabled={busy}
            >
              <Mail size={15} /> Email
            </button>
          )}
          <button type="button" className="doc-button doc-button-secondary" onClick={print} disabled={busy}>
            <Printer size={15} /> Print
          </button>
          <button
            type="button"
            className="doc-button doc-button-primary"
            onClick={download}
            disabled={busy}
            aria-busy={downloading}
          >
            {downloading ? <LoaderCircle size={15} className="doc-spinning" /> : <Download size={15} />}
            {downloading ? 'Preparing PDF…' : 'Download PDF'}
          </button>
        </div>
      </header>
      {error && (
        <p className="doc-preview-error" role="alert">
          {error}
        </p>
      )}
      {downloadNotice && (
        <p className="doc-download-notice" role="status">
          {downloadNotice}
        </p>
      )}
      {Object.keys(imageErrors).length > 0 && (
        <p className="doc-download-notice" role="status">
          The {Object.keys(imageErrors).join(' and ')} could not be loaded. Update the original image in Brand
          settings.
        </p>
      )}
      <div className="doc-print-hint">
        <Printer size={14} />
        <span>
          {format.name} · {format.layout} · {geometry.pageSize} {geometry.orientation}
        </span>
        {doc.convertedInvoiceId && <span className="doc-converted-note">Converted to invoice</span>}
        {doc.deliveryNoteId && <span className="doc-converted-note">Delivery challan created</span>}
      </div>
      <div
        className="doc-paper-viewport"
        tabIndex={0}
        aria-label="Document preview; scroll to view the full page"
      >
        <article
          className={`doc-paper doc-template-${format.layout} doc-density-${format.density} doc-table-${format.tableStyle || 'ruled'} ${narrow ? 'doc-paper-narrow' : ''} ${delivery ? 'doc-delivery-paper' : ''} ${format.showLogo && logo && !imageErrors.logo ? 'doc-has-logo' : ''}`}
          style={style}
        >
          <div className="doc-paper-accent" />
          <header className="doc-paper-header">
            <div className="doc-brand-block">
              {format.showLogo && logo && !imageErrors.logo && (
                <img
                  className="doc-brand-logo"
                  src={logo}
                  alt={`${organization.name} logo`}
                  onError={() => failImage('logo')}
                />
              )}
              <div className="doc-brand-identity">
                <h2>{organization.name}</h2>
                {identity.tradeName && <p className="doc-trade-name">Trade name: {identity.tradeName}</p>}
                {doc.businessProductSnapshot?.name && (
                  <p className="doc-business-product">
                    <span>Product:</span> <strong>{doc.businessProductSnapshot.name}</strong>
                  </p>
                )}
                {identity.showLegalName && (
                  <>
                    <p>{identity.legalLabel}</p>
                    <h3>{identity.legalName}</h3>
                  </>
                )}
              </div>
            </div>
            <div className="doc-paper-document-label">
              <h1>{documentTitle(doc)}</h1>
              <strong>{doc.number}</strong>
              <span className="doc-paper-status">
                {STATUS_LABELS[doc.status] || doc.status}
                {doc.finalizedAt ? ' · Final' : ''}
              </span>
            </div>
          </header>
          <section className="doc-paper-parties">
            <div className="doc-party">
              <span className="doc-paper-eyebrow">From</span>
              <strong>{identity.sellerName}</strong>
              {identity.sellerLegalName && <p>{identity.sellerLegalName}</p>}
              {organization.address && <p className="doc-preserve-lines">{organization.address}</p>}
              {organization.stateCode && (
                <p>
                  {stateName(organization.stateCode)} · State code {organization.stateCode}
                </p>
              )}
              {organization.gstin && <p className="doc-gstin">GSTIN: {organization.gstin}</p>}
              {organization.pan && <p>PAN: {organization.pan}</p>}
              {organization.cin && <p>CIN: {organization.cin}</p>}
              {organization.email && <p>{organization.email}</p>}
              {organization.phone && <p>{organization.phone}</p>}
            </div>
            <div className="doc-party">
              <span className="doc-paper-eyebrow">{delivery ? 'Customer' : 'Bill to'}</span>
              <strong>{customer.name}</strong>
              {customer.contactPerson && <p>Attn: {customer.contactPerson}</p>}
              {customer.address && <p className="doc-preserve-lines">{customer.address}</p>}
              {customer.stateCode && (
                <p>
                  {stateName(customer.stateCode)} · State code {customer.stateCode}
                </p>
              )}
              {customer.gstin && <p className="doc-gstin">GSTIN: {customer.gstin}</p>}
              {customer.email && <p>{customer.email}</p>}
              {customer.phone && <p>{customer.phone}</p>}
            </div>
            <div className="doc-date-details">
              <div>
                <span className="doc-paper-eyebrow">Issue date</span>
                <strong>{date(doc.issueDate)}</strong>
              </div>
              {documentDueDate(doc) && (
                <div>
                  <span className="doc-paper-eyebrow">{documentDueLabel(doc)}</span>
                  <strong>{date(documentDueDate(doc))}</strong>
                </div>
              )}
              {doc.placeOfSupply && (
                <div>
                  <span className="doc-paper-eyebrow">Place of supply</span>
                  <strong>
                    {stateName(doc.placeOfSupply)} ({doc.placeOfSupply})
                  </strong>
                </div>
              )}
            </div>
          </section>
          {shipping.length > 0 && (
            <section className="doc-paper-shipping">
              <span className="doc-paper-eyebrow">Shipping details</span>
              <div className="doc-shipping-columns">
                {shippingGroups(doc).map((group, index) => (
                  <dl key={index}>
                    {group.map(([label, value]) => (
                      <Fragment key={label}>
                        <dt>{label}</dt>
                        <dd className="doc-preserve-lines">{value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                ))}
              </div>
            </section>
          )}
          {subject && (
            <div className="doc-project-title">
              <span className="doc-paper-eyebrow">Subject</span>
              <h3>{subject}</h3>
            </div>
          )}
          {doc.kind === 'proforma' && (
            <p className="doc-proforma-note">Proforma invoice — not a tax invoice.</p>
          )}
          <div className="doc-paper-table-wrap">
            <table className="doc-paper-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Description</th>
                  {format.showHsn && <th>HSN / SAC</th>}
                  <th className="doc-align-right">Qty</th>
                  {format.showUnit && <th>Unit</th>}
                  {!delivery && (
                    <>
                      <th className="doc-align-right">Rate</th>
                      {format.showGstRate && <th className="doc-align-right">GST</th>}
                      <th className="doc-align-right">Amount</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {doc.items.map((item, index) => (
                  <Fragment key={index}>
                    <tr>
                      <td className="doc-row-number">{index + 1}</td>
                      <td className="doc-paper-description">{item.description}</td>
                      {format.showHsn && <td>{item.hsn || '—'}</td>}
                      <td className="doc-align-right">{item.quantity}</td>
                      {format.showUnit && <td>{item.unit || '—'}</td>}
                      {!delivery && (
                        <>
                          <td className="doc-align-right doc-no-wrap">{money(item.rate)}</td>
                          {format.showGstRate && (
                            <td className="doc-align-right doc-no-wrap">{item.gstRate}%</td>
                          )}
                          <td className="doc-align-right doc-no-wrap doc-paper-amount">
                            {money(calculateLineAmount(item))}
                          </td>
                        </>
                      )}
                    </tr>
                    {linePricingNote(doc, item) && (
                      <tr className="doc-pricing-detail-row">
                        <td />
                        <td
                          colSpan={
                            2 +
                            Number(format.showHsn) +
                            Number(format.showUnit) +
                            (!delivery ? 2 + Number(format.showGstRate) : 0)
                          }
                        >
                          <div className="doc-line-pricing">{linePricingNote(doc, item)}</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <section className="doc-paper-summary">
            <div className="doc-paper-note">
              {doc.notes && (
                <>
                  <span className="doc-paper-eyebrow">Notes</span>
                  <p className="doc-preserve-lines">{doc.notes}</p>
                </>
              )}
              {doc.kind === 'quotation' && (
                <p className="doc-quotation-note">
                  This quotation is an estimate of the services and prices listed above.
                </p>
              )}
              {!delivery && format.showAmountInWords && (
                <div className="doc-amount-words">
                  <span className="doc-paper-eyebrow">Amount in words</span>
                  <strong>{amountInWords(totals.total)}</strong>
                </div>
              )}
            </div>
            {!delivery && (
              <div className="doc-paper-totals">
                <div>
                  <span>Subtotal</span>
                  <span>{money(totals.subtotal)}</span>
                </div>
                {totals.discount > 0 && (
                  <div>
                    <span>Discount ({doc.discountPercent}%)</span>
                    <span>− {money(totals.discount)}</span>
                  </div>
                )}
                <div>
                  <span>Taxable amount</span>
                  <span>{money(totals.taxable)}</span>
                </div>
                {totals.cgst > 0 && (
                  <div>
                    <span>CGST</span>
                    <span>{money(totals.cgst)}</span>
                  </div>
                )}
                {totals.sgst > 0 && (
                  <div>
                    <span>SGST / UTGST</span>
                    <span>{money(totals.sgst)}</span>
                  </div>
                )}
                {totals.igst > 0 && (
                  <div>
                    <span>IGST</span>
                    <span>{money(totals.igst)}</span>
                  </div>
                )}
                <div className="doc-paper-grand-total">
                  <span>
                    Total <small>INR</small>
                  </span>
                  <strong>{money(totals.total)}</strong>
                </div>
                {isInvoice && (
                  <>
                    <div className="doc-received">
                      <span>Amount received</span>
                      <span>{money(paidAmount(doc))}</span>
                    </div>
                    <div className="doc-balance">
                      <strong>Balance due</strong>
                      <strong>{money(balanceDue(doc))}</strong>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
          {installments.length > 0 && (
            <section className="doc-installment-section">
              <table className="doc-installment-table">
                <thead>
                  <tr>
                    <th colSpan={6}>
                      <span className="doc-paper-eyebrow">Payment schedule / EMI</span>
                      <strong>{doc.installmentPlan?.name}</strong>
                    </th>
                  </tr>
                  <tr>
                    <th>Installment</th>
                    <th>Due date</th>
                    <th className="doc-align-right">Amount</th>
                    <th className="doc-align-right">Received</th>
                    <th className="doc-align-right">Pending</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {installments.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.label}</td>
                      <td>{date(entry.dueDate)}</td>
                      <td className="doc-align-right">{money(entry.amount)}</td>
                      <td className="doc-align-right">{money(entry.amountPaid)}</td>
                      <td className="doc-align-right">{money(entry.balanceDue)}</td>
                      <td>{INSTALLMENT_STATUS_LABELS[entry.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {(bank.length > 0 || doc.terms || showQr) && (
            <section
              className={`doc-paper-bottom ${showQr ? 'doc-bottom-has-qr' : ''}`}
              style={
                {
                  '--doc-bottom-text-cols': Number(bank.length > 0) + Number(Boolean(doc.terms)),
                } as CSSProperties
              }
            >
              {bank.length > 0 && (
                <div>
                  <span className="doc-paper-eyebrow">Bank details</span>
                  <dl className="doc-bank-details">
                    {bank.map(([label, value]) => (
                      <div className="doc-bank-entry" key={label}>
                        <dt>{label}:</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              {doc.terms && (
                <div>
                  <span className="doc-paper-eyebrow">Terms & conditions</span>
                  <p className="doc-preserve-lines">{doc.terms}</p>
                </div>
              )}
              {showQr && (
                <div className="doc-payment-qr">
                  <span className="doc-paper-eyebrow">Scan to pay</span>
                  <img
                    src={organization.paymentQrUrl}
                    alt="Payment QR code"
                    onError={() => failImage('payment QR')}
                  />
                </div>
              )}
            </section>
          )}
          <section className="doc-paper-signoff doc-signing-section">
            <div className="doc-signing-heading">
              <div>
                {format.footerText && <p className="doc-preserve-lines">{format.footerText}</p>}
                <span className="doc-support-email">
                  {identity.supportEmail ? `Support: ${identity.supportEmail}` : organization.name}
                </span>
              </div>
              {signingBlocks.length > 0 && <span>For {identity.signoffName}</span>}
            </div>
            {signingBlocks.length > 0 && (
              <div
                className="doc-signing-grid"
                style={
                  {
                    '--doc-signing-count': Math.min(signingBlocks.length, narrow ? 2 : 3),
                    '--doc-signing-height': `${Math.max(58.67, ...signingBlocks.map((block) => (block.key === 'stamp' && block.imageUrl && !imageErrors[block.key] ? block.width : 72)))}px`,
                  } as CSSProperties
                }
              >
                {signingBlocks.map((block) => (
                  <div className={`doc-signing-cell doc-signing-${block.key}`} key={block.key}>
                    <div className="doc-signing-frame">
                      {block.imageUrl && !imageErrors[block.key] && (
                        <img
                          src={block.imageUrl}
                          alt={
                            block.key === 'stamp'
                              ? 'Company stamp'
                              : block.key === 'signature'
                                ? 'Primary signature'
                                : 'Secondary signature'
                          }
                          style={{ '--doc-signing-image-width': `${block.width}px` } as CSSProperties}
                          onError={() => failImage(block.key)}
                        />
                      )}
                    </div>
                    <p className="doc-signing-label">{block.label}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
          <footer className="doc-paper-footer">
            <span>{identity.signoffName}</span>
            <span>
              {doc.number} · {DOCUMENT_LABELS[doc.kind]}
            </span>
          </footer>
        </article>
      </div>
    </section>
  );
}

import { Calculator, Gem, Repeat2 } from 'lucide-react';
import { emptyJewelleryPricing } from '../../../shared/billing-presets';
import { linePriceBreakdown, money } from '../../../shared/types';
import type { BillingProfile, PricingDetails } from '../../../shared/types';
import './pricing.css';

interface Props {
  value?: PricingDetails;
  onChange: (pricing?: PricingDetails) => void;
  rate: number;
  unit?: string;
  quantity?: number;
  profile?: BillingProfile;
  disabled?: boolean;
  idPrefix?: string;
  showMode?: boolean;
}

export function validatePricing(pricing?: PricingDetails): string {
  if (!pricing || pricing.mode === 'standard') return '';
  if (pricing.mode === 'recurring')
    return !Number.isFinite(pricing.periods) || (pricing.periods ?? 0) <= 0 || (pricing.periods ?? 0) > 1200
      ? 'Enter periods above zero and no more than 1,200.'
      : '';
  const j = pricing.jewellery;
  if (!j) return 'Add the jewellery weight and making details.';
  if (!Number.isFinite(j.grossWeight) || j.grossWeight <= 0 || j.grossWeight > 1000000)
    return 'Gross weight per item must be above zero and no more than 1,000,000 g.';
  if (!Number.isFinite(j.stoneWeight) || j.stoneWeight < 0 || j.stoneWeight >= j.grossWeight)
    return 'Stone weight must be non-negative and less than gross weight, leaving a positive net metal weight.';
  if (
    [j.makingCharge, j.stoneAmount, j.otherCharges].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 100000000,
    )
  )
    return 'Making, stone and other charges must be between zero and ₹10 crore.';
  if (
    !Number.isFinite(j.wastagePercent) ||
    j.wastagePercent < 0 ||
    j.wastagePercent > 100 ||
    (j.makingChargeType === 'percent' && j.makingCharge > 100)
  )
    return 'Wastage and percentage making charges must be between 0% and 100%.';
  return '';
}

export default function PricingFields({
  value,
  onChange,
  rate,
  unit = 'Unit',
  quantity = 1,
  profile = 'general',
  disabled = false,
  idPrefix = 'pricing',
  showMode = true,
}: Props) {
  const mode = value?.mode ?? 'standard';
  const details = linePriceBreakdown({ quantity, rate, pricing: value });
  const jewellery = value?.jewellery ?? emptyJewelleryPricing().jewellery!;
  function changeJewellery<K extends keyof NonNullable<PricingDetails['jewellery']>>(
    key: K,
    next: NonNullable<PricingDetails['jewellery']>[K],
  ) {
    onChange({ mode: 'jewellery', jewellery: { ...jewellery, [key]: next } });
  }
  return (
    <fieldset className="pricing-fields" disabled={disabled}>
      {showMode && (
        <div className="pricing-mode-row">
          <label htmlFor={`${idPrefix}-mode`}>
            <Calculator size={14} /> Pricing method
          </label>
          <select
            id={`${idPrefix}-mode`}
            value={mode}
            onChange={(event) =>
              onChange(
                event.target.value === 'standard'
                  ? undefined
                  : event.target.value === 'recurring'
                    ? { mode: 'recurring', periods: 1, periodUnit: 'Month' }
                    : emptyJewelleryPricing(),
              )
            }
          >
            <option value="standard">Standard · quantity × rate</option>
            <option value="recurring">Recurring · units × periods × rate</option>
            <option value="jewellery">Jewellery · metal + making + charges</option>
          </select>
        </div>
      )}
      {mode === 'standard' && (
        <p className="pricing-hint">
          {profile === 'legal'
            ? 'Use hours, cases, consultations or retainers as the billing unit.'
            : profile === 'space'
              ? 'Use area, seats, rooms or project units for your agreed rate.'
              : 'The item quantity is multiplied by its rate per unit.'}
        </p>
      )}
      {mode === 'recurring' && (
        <>
          <div className="pricing-detail-heading">
            <Repeat2 size={15} />
            <strong>Billing periods</strong>
            <span>Rate is per {unit || 'unit'} per period</span>
          </div>
          <div className="pricing-fields-grid pricing-recurring-grid">
            <label>
              Number of periods
              <input
                type="number"
                min="0.001"
                max="1200"
                step="any"
                value={value?.periods ?? 1}
                onChange={(event) =>
                  onChange({
                    ...value,
                    mode: 'recurring',
                    periods: Number(event.target.value),
                    periodUnit: value?.periodUnit ?? 'Month',
                  })
                }
              />
            </label>
            <label>
              Period unit
              <select
                value={value?.periodUnit ?? 'Month'}
                onChange={(event) =>
                  onChange({
                    ...value,
                    mode: 'recurring',
                    periods: value?.periods ?? 1,
                    periodUnit: event.target.value as PricingDetails['periodUnit'],
                  })
                }
              >
                {['Hour', 'Day', 'Month', 'Year'].map((period) => (
                  <option key={period} value={period}>
                    {period}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="pricing-formula">
            {quantity} {unit || 'units'} × {value?.periods ?? 1}{' '}
            {(value?.periodUnit ?? 'Month').toLowerCase()} ×{' '}
            {Number.isFinite(rate) ? money(rate) : 'Enter rate'} = <strong>{money(details.total)}</strong>
          </p>
        </>
      )}
      {mode === 'jewellery' && (
        <>
          <div className="pricing-detail-heading">
            <Gem size={15} />
            <strong>Jewellery details per item</strong>
            <span>The item rate is the metal price per gram</span>
          </div>
          <div className="pricing-fields-grid">
            <label>
              Gross weight (g)
              <input
                type="number"
                min="0.000001"
                max="1000000"
                step="any"
                value={jewellery.grossWeight}
                onChange={(event) => changeJewellery('grossWeight', Number(event.target.value))}
              />
            </label>
            <label>
              Stone weight (g)
              <input
                type="number"
                min="0"
                max="1000000"
                step="any"
                value={jewellery.stoneWeight}
                onChange={(event) => changeJewellery('stoneWeight', Number(event.target.value))}
              />
            </label>
            <label>
              Net metal weight (g)
              <output className="pricing-net-weight">{Number(details.netWeight.toFixed(6))} g</output>
            </label>
            <label>
              Purity / hallmark
              <input
                placeholder="e.g. 22K / 916"
                value={jewellery.purity}
                maxLength={100}
                onChange={(event) => changeJewellery('purity', event.target.value)}
              />
            </label>
            <label>
              Making charge method
              <select
                value={jewellery.makingChargeType}
                onChange={(event) =>
                  changeJewellery('makingChargeType', event.target.value as typeof jewellery.makingChargeType)
                }
              >
                <option value="per_gram">Per gram of net metal</option>
                <option value="fixed">Fixed per item</option>
                <option value="percent">% of metal value</option>
              </select>
            </label>
            <label>
              Making charge (
              {jewellery.makingChargeType === 'percent'
                ? '%'
                : jewellery.makingChargeType === 'per_gram'
                  ? '₹/g'
                  : '₹/item'}
              )
              <input
                type="number"
                min="0"
                max={jewellery.makingChargeType === 'percent' ? 100 : 100000000}
                step="any"
                value={jewellery.makingCharge}
                onChange={(event) => changeJewellery('makingCharge', Number(event.target.value))}
              />
            </label>
            <label>
              Stone value (₹/item)
              <input
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                value={jewellery.stoneAmount}
                onChange={(event) => changeJewellery('stoneAmount', Number(event.target.value))}
              />
            </label>
            <label>
              Wastage (% of metal)
              <input
                type="number"
                min="0"
                max="100"
                step="any"
                value={jewellery.wastagePercent}
                onChange={(event) => changeJewellery('wastagePercent', Number(event.target.value))}
              />
            </label>
            <label>
              Other charges (₹/item)
              <input
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                value={jewellery.otherCharges}
                onChange={(event) => changeJewellery('otherCharges', Number(event.target.value))}
              />
            </label>
          </div>
          <div className="pricing-breakdown" aria-label="Jewellery price breakdown">
            <span>
              Metal <strong>{money(details.base)}</strong>
            </span>
            <span>
              Making <strong>{money(details.making)}</strong>
            </span>
            <span>
              Stones <strong>{money(details.stones)}</strong>
            </span>
            <span>
              Wastage <strong>{money(details.wastage)}</strong>
            </span>
            <span>
              Other <strong>{money(details.other)}</strong>
            </span>
            <span className="pricing-breakdown-total">
              {quantity} {quantity === 1 ? 'item' : 'items'} total <strong>{money(details.total)}</strong>
            </span>
          </div>
          <p className="pricing-hint">
            Gross and stone weights are for one item. All charges are multiplied by the item quantity. GST and
            document discount are calculated after this subtotal.
          </p>
        </>
      )}
    </fieldset>
  );
}

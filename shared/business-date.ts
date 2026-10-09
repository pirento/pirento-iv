const indiaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The issuer's India calendar day, independent of the server's local timezone. */
export function businessDateInIndia(date: Date): string {
  const parts = Object.fromEntries(
    indiaDateFormatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

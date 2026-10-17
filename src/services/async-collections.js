/** Sequential helpers keep MongoDB session operations ordered inside transactions. */
export async function mapAsync(values, mapper) {
  const result = [];
  for (let index = 0; index < values.length; index++) result.push(await mapper(values[index], index, values));
  return result;
}
// Async flatMap / filter / find / some / every / forEach, also one item at a time.
export async function flatMapAsync(values, mapper) {
  return (await mapAsync(values, mapper)).flat();
}
export async function filterAsync(values, predicate) {
  const result = [];
  for (let index = 0; index < values.length; index++)
    if (await predicate(values[index], index, values)) result.push(values[index]);
  return result;
}
export async function findAsync(values, predicate) {
  for (let index = 0; index < values.length; index++)
    if (await predicate(values[index], index, values)) return values[index];
}
export async function someAsync(values, predicate) {
  for (let index = 0; index < values.length; index++)
    if (await predicate(values[index], index, values)) return true;
  return false;
}
export async function everyAsync(values, predicate) {
  for (let index = 0; index < values.length; index++)
    if (!(await predicate(values[index], index, values))) return false;
  return true;
}
export async function forEachAsync(values, action) {
  await mapAsync(values, action);
}

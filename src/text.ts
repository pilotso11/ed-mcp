/** "1 stop", "3 stops"; give the plural when it is not the noun plus s. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

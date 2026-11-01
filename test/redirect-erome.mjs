// Só para testes: manda as chamadas ao erome para o servidor falso.
const real = globalThis.fetch;
globalThis.fetch = (url, opts) => real(String(url).replace('https://www.erome.com', process.env.MOCK_BASE), opts);

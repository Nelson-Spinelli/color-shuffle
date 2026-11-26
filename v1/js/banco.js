/* =============================================================================
 * COLOR SHUFFLE — CAMADA DE DADOS (banco.js)
 * -----------------------------------------------------------------------------
 * O jogo online guarda tudo numa árvore JSON:
 *   jogadores/{uid}  -> { nome, ultimoAcesso }                (cadastro do nome)
 *   salas/{codigo}   -> { nome, nivel, estado, jogadores, placar, jogo }  (partidas)
 *   ranking/{uid}    -> { nome, vitorias, derrotas, partidas, recorde, pontos }
 *
 * Duas implementações com A MESMA interface:
 *   1. criarBancoFirebase(config): Firebase Realtime Database (online de verdade,
 *      jogadores em aparelhos diferentes, ranking global).
 *   2. criarBancoLocal(): localStorage + BroadcastChannel. Serve para testar sem
 *      servidor (duas abas do mesmo navegador conversam entre si) e, com
 *      persistir = false, para a partida "no mesmo aparelho" (só na memória).
 *
 * Interface: ler, escrever, atualizar, remover, ouvir, novaChave,
 *            aoDesconectar, cancelarDesconexao, transacao.
 * ========================================================================== */

const FIREBASE_VERSAO = '10.12.2';

// ---------- utilidades para navegar na árvore JSON por "caminho/com/barras" ----------
const partes = (caminho) => String(caminho).split('/').filter(Boolean);
const clonar = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function lerEm(arvore, caminho) {
  let no = arvore;
  for (const p of partes(caminho)) {
    if (no === null || typeof no !== 'object') return null;
    no = no[p];
  }
  return no === undefined ? null : no;
}

function gravarEm(arvore, caminho, valor) {
  const ps = partes(caminho);
  let no = arvore;
  for (let i = 0; i < ps.length - 1; i++) {
    if (no[ps[i]] === null || typeof no[ps[i]] !== 'object') no[ps[i]] = {};
    no = no[ps[i]];
  }
  const ultima = ps[ps.length - 1];
  if (valor === null || valor === undefined) delete no[ultima];
  else no[ultima] = clonar(valor);
}

/**
 * Banco local (sem servidor).
 * persistir = true  -> localStorage + BroadcastChannel (várias abas = vários jogadores)
 * persistir = false -> só memória (partida no mesmo aparelho)
 */
export function criarBancoLocal({ persistir = true, chave = 'colorShuffle.banco' } = {}) {
  let arvore = {};
  const ouvintes = new Set();
  const desconexao = [];
  const canal = persistir && 'BroadcastChannel' in self ? new BroadcastChannel(chave) : null;

  const carregar = () => {
    if (!persistir) return;
    try { arvore = JSON.parse(localStorage.getItem(chave) || '{}'); } catch (e) { arvore = {}; }
  };
  const salvar = () => {
    if (!persistir) return;
    try { localStorage.setItem(chave, JSON.stringify(arvore)); } catch (e) { /* armazenamento bloqueado */ }
  };
  const notificar = () => { for (const o of ouvintes) o.disparar(); };
  // Avisa ouvintes desta aba e das outras abas (de forma assíncrona, como o Firebase)
  const mudou = () => { salvar(); if (canal) canal.postMessage(Date.now()); queueMicrotask(notificar); };

  carregar();
  if (canal) canal.onmessage = () => { carregar(); notificar(); };
  if (persistir) {
    // Equivalente ao onDisconnect do Firebase: ao fechar a aba, aplica as remoções combinadas
    addEventListener('pagehide', () => {
      carregar();
      for (const [c, v] of desconexao) gravarEm(arvore, c, v);
      salvar();
      if (canal) canal.postMessage(Date.now());
    });
  }

  return {
    modo: persistir ? 'local' : 'memoria',
    async ler(c) { carregar(); return clonar(lerEm(arvore, c)); },
    async escrever(c, v) { carregar(); gravarEm(arvore, c, v); mudou(); },
    /** Atualiza vários caminhos de uma vez (chaves podem ter barras: "jogo/posicao"). */
    async atualizar(c, valores) {
      carregar();
      for (const [k, v] of Object.entries(valores)) gravarEm(arvore, `${c}/${k}`, v);
      mudou();
    },
    async remover(c) { carregar(); gravarEm(arvore, c, null); mudou(); },
    /** Chama cb(valor) agora e sempre que o valor do caminho mudar. Devolve a função para parar. */
    ouvir(c, cb) {
      let ultimo;
      const o = {
        disparar() {
          const atual = JSON.stringify(lerEm(arvore, c));
          if (atual !== ultimo) { ultimo = atual; cb(JSON.parse(atual)); }
        },
      };
      ouvintes.add(o);
      queueMicrotask(() => o.disparar());
      return () => ouvintes.delete(o);
    },
    novaChave() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
    aoDesconectar(c, v) { desconexao.push([c, v]); },
    cancelarDesconexao() { desconexao.length = 0; },
    /** Lê, aplica fn e grava (fn devolve undefined para cancelar). */
    async transacao(c, fn) {
      carregar();
      const novo = fn(clonar(lerEm(arvore, c)));
      if (novo !== undefined) { gravarEm(arvore, c, novo); mudou(); }
      return { committed: novo !== undefined };
    },
  };
}

/** Banco online: Firebase Realtime Database (SDK carregado do CDN oficial do Google). */
export async function criarBancoFirebase(config) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSAO}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fb = await import(`${base}/firebase-database.js`);
  const app = initializeApp(config);
  const db = fb.getDatabase(app);
  const ref = (c) => fb.ref(db, c);
  const desconexoes = [];

  // Testa a conexão (falha rápido se a URL do banco estiver errada)
  await Promise.race([
    fb.get(ref('.info/serverTimeOffset')).catch(() => null),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Firebase não respondeu')), 8000)),
  ]);

  return {
    modo: 'online',
    async ler(c) { const s = await fb.get(ref(c)); return s.exists() ? s.val() : null; },
    escrever: (c, v) => fb.set(ref(c), v),
    atualizar: (c, valores) => fb.update(ref(c), valores),
    remover: (c) => fb.remove(ref(c)),
    ouvir(c, cb) { return fb.onValue(ref(c), (s) => cb(s.exists() ? s.val() : null)); },
    novaChave: () => fb.push(ref('_chaves')).key,
    aoDesconectar(c, v) {
      const od = fb.onDisconnect(ref(c));
      if (v === null) od.remove(); else od.set(v);
      desconexoes.push(od);
    },
    cancelarDesconexao() { desconexoes.splice(0).forEach((od) => od.cancel()); },
    transacao: (c, fn) => fb.runTransaction(ref(c), fn),
  };
}

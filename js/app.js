/* =============================================================================
 * COLOR SHUFFLE — INTERFACE, LOBBY E PARTIDA ONLINE (app.js)
 * -----------------------------------------------------------------------------
 *  1. Estado, preferências e conexão (Firebase online ou modo local de teste)
 *  2. Motor de áudio (Web Audio API — sons sintetizados, sem arquivos)
 *  3. Efeitos visuais (onda de luz, "+1", confete, tremida)
 *  4. A caixa: monta as 2 fileiras (a SUA fileira fica sempre na frente)
 *  5. Mini display (imita a tela OLED 128x64 do protótipo)
 *  6. Telas: entrada (nome), lobby (criar/entrar/ranking) e jogo
 *  7. Partida: a sala no banco é a "fonte da verdade"; cada aparelho reage
 *     às mudanças (eventos numerados) e só o jogador da vez grava jogadas
 *  8. Eventos de clique, toque (Pointer Events) e teclado
 * As regras (sequência, turnos, pontos, vencedor) vêm do genius-core.js,
 * as mesmas do protótipo no Raspberry Pi e dos testes automatizados.
 * ========================================================================== */
import { criarBancoLocal, criarBancoFirebase } from './banco.js?v=2.2';
import { firebaseConfig } from './firebase-config.js?v=2.2';

const G = window.GeniusCore;
const { ESTADOS } = G;

// ---------------------------------------------------------------------------
// 1. ESTADO, PREFERÊNCIAS E CONEXÃO
// ---------------------------------------------------------------------------
const ESCALA_TEMPO = Number(window.GENIUS_ESCALA_TEMPO) > 0 ? Number(window.GENIUS_ESCALA_TEMPO) : 1; // só testes aceleram
const MOVIMENTO_REDUZIDO = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CLIENTE = Math.random().toString(36).slice(2, 10);   // identifica ESTA aba (origem dos eventos)
const CHAVE_PREFS = 'colorShuffle.prefs';

const prefs = (() => {
  const padrao = { som: true, volume: 70, visual: 'classico', nivel: 'facil', recorde: 0 };
  try { return { ...padrao, ...JSON.parse(localStorage.getItem(CHAVE_PREFS) || '{}') }; } catch (e) { return padrao; }
})();
function salvarPrefs() { try { localStorage.setItem(CHAVE_PREFS, JSON.stringify(prefs)); } catch (e) { /* modo privado */ } }

/**
 * Identidade do jogador (uid + nome). Online fica no localStorage (o ranking acompanha
 * o jogador). No modo local de teste fica no sessionStorage: cada ABA é um jogador.
 */
const eu = { uid: '', nome: '' };
let armazenamentoId = null;
function carregarIdentidade(local) {
  armazenamentoId = local ? sessionStorage : localStorage;
  try { Object.assign(eu, JSON.parse(armazenamentoId.getItem('colorShuffle.eu') || '{}')); } catch (e) { /* sem armazenamento */ }
  if (!eu.uid) eu.uid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  salvarIdentidade();
}
function salvarIdentidade() { try { armazenamentoId.setItem('colorShuffle.eu', JSON.stringify(eu)); } catch (e) { /* sem armazenamento */ } }

let banco = null;           // banco online (Firebase) ou local de teste
let pararLobby = [];        // funções para parar de ouvir salas/ranking
let token = 0;              // "ficha" das animações: mudar o valor cancela esperas pendentes

/** Estado da partida aberta neste aparelho. */
const P = {
  store: null,       // banco onde a sala está (online ou memória)
  salaId: null,
  meu: 0,            // 1 ou 2 = meu número; 0 = os dois jogam neste aparelho
  local: false,      // true = partida no mesmo aparelho (não conta no ranking)
  sala: null,        // último estado recebido da sala
  parar: null,       // função para parar de ouvir a sala
  ultimoN: -1,       // último evento processado
  rodadaVista: 0,    // última rodada já apresentada (sequência mostrada) neste aparelho
  apresentando: false,
  ultimaSequencia: [],
  jogadoresAntes: null,
  ultimoStart: 0,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const el = {
  corpo: document.body, status: $('#status'), anuncio: $('#anuncio'),
  fileiraFrente: $('#fileira-frente'), fileiraFundo: $('#fileira-fundo'),
  start: $('#btn-start'), dicaStart: $('#dica-start'),
  oled: { caixa: $('#oled'), l1: $('#oled-l1'), l2: $('#oled-l2'), l3: $('#oled-l3'), cima: $('#oled-seta-c'), baixo: $('#oled-seta-b') },
  cartoes: { 1: $('#cartao-j1'), 2: $('#cartao-j2') }, nomes: { 1: $('#nome-1'), 2: $('#nome-2') }, lados: { 1: $('#lado-1'), 2: $('#lado-2') },
  pontos: { 1: $('#pontos-1'), 2: $('#pontos-2') }, vitorias: { 1: $('#vitorias-1'), 2: $('#vitorias-2') },
  progresso: $('#progresso'), infoRodada: $('#info-rodada'), infoSeq: $('#info-seq'), infoRecorde: $('#info-recorde'),
  infoSala: $('#info-sala'), volume: $('#volume'), volumeValor: $('#volume-valor'), rever: $('#btn-rever'),
  som: $('#btn-som'), tema: $('#btn-tema'), ajuda: $('#btn-ajuda'), seloModo: $('#selo-modo'), avisoModo: $('#aviso-modo'),
  log: $('#log'), confete: $('#confete'), dlgFim: $('#dlg-fim'), dlgAjuda: $('#dlg-ajuda'), dlgVisual: $('#dlg-visual'), palco: $('#palco'), caixa: $('#tabuleiro'),
  listaSalas: $('#lista-salas'), contadorSalas: $('#contador-salas'), rankingCorpo: $('#ranking-corpo'), suaPosicao: $('#sua-posicao'),
};
const SIMBOLO = { verde: '▲', vermelho: '●', amarelo: '■', azul: '◆' };
const k = (n) => `j${n}`;                                  // chaves no banco: j1 / j2
const outro = (n) => (n === 1 ? 2 : 1);

class Cancelado extends Error {}
/** Espera "ms"; se o token mudar (jogo parado/reiniciado), cancela. */
function esperar(ms, t) {
  return new Promise((ok, falha) => setTimeout(() => (t === token ? ok() : falha(new Cancelado())), ms * ESCALA_TEMPO));
}
const ignorarCancelado = (e) => { if (!(e instanceof Cancelado)) console.error(e); };
const escapar = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

// ---------------------------------------------------------------------------
// 2. MOTOR DE ÁUDIO (Web Audio API)
// ---------------------------------------------------------------------------
const NOTA_COR = { verde: 329.63, vermelho: 440.0, amarelo: 554.37, azul: 659.25 };  // acorde de Lá maior
const NOTAS_TURNO = [1760, 1865, 1976, 2093];                                        // NOTAS_TURNO do protótipo
const NOTA_BIP = 2000;                                                               // NOTA_BIP do protótipo

const Som = {
  ctx: null, mestre: null,
  /** Cria/desbloqueia o áudio (navegadores exigem um toque do usuário antes). */
  preparar() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.mestre = this.ctx.createGain();
      this.mestre.connect(comp).connect(this.ctx.destination);
      this.volume();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  volume() { if (this.mestre) this.mestre.gain.value = Math.pow(prefs.volume / 100, 1.6); },
  /** Nota com envelope (ataque, decaimento, sustentação, relaxamento). */
  tom(freq, ms, { tipo = 'triangle', volume = 0.3, atraso = 0, deslize = null, harmonico = 0 } = {}) {
    if (!prefs.som || prefs.volume === 0) return;
    const ctx = this.preparar();
    if (!ctx) return;
    const dur = Math.max(ms * ESCALA_TEMPO, 40) / 1000;
    const t0 = ctx.currentTime + atraso * ESCALA_TEMPO + 0.005;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(volume, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(volume * 0.7, t0 + Math.min(0.08, dur * 0.4));
    g.gain.setValueAtTime(volume * 0.7, t0 + Math.max(dur - 0.05, 0.09));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.04);
    g.connect(this.mestre);
    const oscs = [[freq, tipo, 1]];
    if (harmonico) oscs.push([freq * 2, 'sine', harmonico]);
    for (const [f, tp, vol] of oscs) {
      const o = ctx.createOscillator();
      o.type = tp;
      o.frequency.setValueAtTime(f, t0);
      if (deslize) o.frequency.exponentialRampToValueAtTime(f * deslize, t0 + dur);
      let destino = g;
      if (vol !== 1) { destino = ctx.createGain(); destino.gain.value = vol; destino.connect(g); }
      o.connect(destino); o.start(t0); o.stop(t0 + dur + 0.08);
    }
  },
  cor(cor, ms) { this.tom(NOTA_COR[cor], ms, { harmonico: 0.25, volume: 0.32 }); },
  inicio() {   // arpejo + bip(0.08, vezes=2) do Python
    ['verde', 'vermelho', 'amarelo', 'azul'].forEach((c, i) => this.tom(NOTA_COR[c], 110, { atraso: i * 0.07, harmonico: 0.3, volume: 0.22 }));
    this.tom(NOTA_BIP, 70, { tipo: 'square', volume: 0.05, atraso: 0.65 });
    this.tom(NOTA_BIP, 70, { tipo: 'square', volume: 0.05, atraso: 0.81 });
  },
  acertou() { this.tom(1318.5, 90, { tipo: 'sine', volume: 0.16 }); this.tom(1760, 160, { tipo: 'sine', volume: 0.16, atraso: 0.09 }); },
  turno(i, ms) { this.tom(NOTAS_TURNO[i], ms, { tipo: 'sine', volume: 0.13 }); },
  negado() { this.tom(196, 70, { tipo: 'square', volume: 0.06 }); this.tom(165, 90, { tipo: 'square', volume: 0.06, atraso: 0.08 }); },
  erro() {     // bip(0.7) do Python, mais grave + três notas descendo
    this.tom(110, 650, { tipo: 'sawtooth', volume: 0.16, deslize: 0.7 });
    [392, 330, 262].forEach((f, i) => this.tom(f, 180, { volume: 0.18, atraso: 0.7 + i * 0.17 }));
  },
  vitoria(atraso = 1.3) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tom(f, 150, { atraso: atraso + i * 0.12, harmonico: 0.3, volume: 0.2 }));
    [523.25, 659.25, 783.99].forEach((f) => this.tom(f, 600, { atraso: atraso + 0.5, tipo: 'sine', volume: 0.12 }));
  },
  derrota(atraso = 1.3) { [392, 370, 349, 330].forEach((f, i) => this.tom(f, 260, { atraso: atraso + i * 0.24, volume: 0.14 })); },
  recorde(atraso = 2.3) { for (let i = 0; i < 8; i++) this.tom(1046.5 * Math.pow(2, i / 8), 70, { tipo: 'sine', atraso: atraso + i * 0.05, volume: 0.1 }); },
  entrou() { this.tom(660, 90, { tipo: 'sine', volume: 0.14 }); this.tom(990, 140, { tipo: 'sine', volume: 0.14, atraso: 0.09 }); },
  saiu() { this.tom(660, 90, { tipo: 'sine', volume: 0.12 }); this.tom(440, 160, { tipo: 'sine', volume: 0.12, atraso: 0.09 }); },
  parar() { this.tom(440, 110, { volume: 0.15 }); this.tom(294, 200, { volume: 0.15, atraso: 0.11 }); },
  clique() { this.tom(1200, 30, { tipo: 'sine', volume: 0.06 }); },
};

// ---------------------------------------------------------------------------
// 3. EFEITOS VISUAIS
// ---------------------------------------------------------------------------
function onda(botao) {
  if (MOVIMENTO_REDUZIDO || !botao) return;
  const o = document.createElement('span');
  o.className = 'onda';
  botao.append(o);
  o.addEventListener('animationend', () => o.remove());
}
function animarClasse(elemento, classe) {
  elemento.classList.remove(classe); void elemento.offsetWidth; elemento.classList.add(classe);
}
/** "+1" que voa da fileira do jogador até os pontos dele no placar. */
function maisUm(jogador) {
  const alvo = el.pontos[jogador];
  animarClasse(alvo, 'pulo');
  const fileira = fileiraDe(jogador);
  if (MOVIMENTO_REDUZIDO || !fileira) return;
  const a = fileira.getBoundingClientRect(), b = alvo.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'mais-um'; f.textContent = '+1';
  document.body.append(f);
  const x0 = a.left + a.width / 2 - 18, y0 = a.top + a.height / 2 - 18, x1 = b.left + b.width / 2 - 18, y1 = b.top + b.height / 2 - 18;
  f.animate([
    { transform: `translate(${x0}px, ${y0}px) scale(.6)`, opacity: 0 },
    { transform: `translate(${x0}px, ${y0 - 40}px) scale(1.4)`, opacity: 1, offset: 0.25 },
    { transform: `translate(${x1}px, ${y1}px) scale(.8)`, opacity: 0.9 },
  ], { duration: 850, easing: 'cubic-bezier(.3,.7,.4,1)' }).onfinish = () => f.remove();
}
/** Confete nas 4 cores do jogo. */
function confete() {
  if (MOVIMENTO_REDUZIDO) return;
  const c = el.confete, g2 = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cores = ['#ff5560', '#ffe14a', '#46ff8d', '#59b9ff', '#ffffff'];
  const pecas = Array.from({ length: 150 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.4, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    r: Math.random() * 6 + 4, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.3, cor: cores[Math.floor(Math.random() * cores.length)],
  }));
  const ini = performance.now();
  (function quadro(agora) {
    const t = agora - ini;
    g2.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of pecas) {
      p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      g2.save(); g2.translate(p.x, p.y); g2.rotate(p.a); g2.globalAlpha = Math.max(0, 1 - t / 2600);
      g2.fillStyle = p.cor; g2.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); g2.restore();
    }
    if (t < 2600) requestAnimationFrame(quadro); else g2.clearRect(0, 0, innerWidth, innerHeight);
  })(ini);
}

// ---------------------------------------------------------------------------
// 4. A CAIXA: FILEIRAS DE BOTÕES
// ---------------------------------------------------------------------------
const FORMA = {
  vermelho: '<circle cx="20" cy="20" r="13"/>', amarelo: '<rect x="8" y="8" width="24" height="24" rx="2"/>',
  verde: '<path d="M20 6 34 32H6z"/>', azul: '<path d="M20 4 36 20 20 36 4 20z"/>',
};
const NOME_FORMA = { vermelho: 'círculo', amarelo: 'quadrado', verde: 'triângulo', azul: 'losango' };

/**
 * Monta a caixa com a fileira de "frente" (jogador frente) mais perto de quem joga.
 * Fileira da frente: vermelho, amarelo, verde, azul (igual a B1..B4 do protótipo);
 * fileira do fundo: azul, verde, amarelo, vermelho (como B8..B5 do lado oposto).
 */
function montarCaixa(frente) {
  const cores = G.CORES;   // vermelho, amarelo, verde, azul
  const html = (jogador, ordem, tecla0) => ordem.map((cor) => {
    const n = (jogador === 1 ? 1 : 5) + cores.indexOf(cor);
    const tecla = P.local ? tecla0 + cores.indexOf(cor) : 1 + cores.indexOf(cor);
    return `<button type="button" class="botao ${cor}" data-cor="${cor}" data-jogador="${jogador}" aria-label="B${n} ${cor} (${NOME_FORMA[cor]}), Jogador ${jogador}, tecla ${tecla}">`
      + `<span class="brilho"></span><span class="aro"></span><span class="cil"><i></i><i></i><i></i><i></i></span>`
      + `<span class="cap"><svg class="simbolo" viewBox="0 0 40 40" aria-hidden="true">${FORMA[cor]}</svg></span>`
      + `<span class="num" aria-hidden="true">B${n}</span></button>`;
  }).join('');
  const fundo = outro(frente);
  el.fileiraFrente.dataset.jogador = frente;
  el.fileiraFundo.dataset.jogador = fundo;
  el.fileiraFrente.innerHTML = html(frente, cores, frente === 1 ? 1 : 5);
  el.fileiraFundo.innerHTML = html(fundo, cores.slice().reverse(), fundo === 1 ? 1 : 5);
  el.fileiraFrente.setAttribute('aria-label', `Botões do Jogador ${frente} (fileira da frente)`);
  el.fileiraFundo.setAttribute('aria-label', `Botões do Jogador ${fundo} (fileira do fundo)`);
  $$('.botao').forEach((b) => ligarBotao(b, () => pressionar(b.dataset.cor, Number(b.dataset.jogador), b)));
}
const fileiraDe = (j) => (Number(el.fileiraFrente.dataset.jogador) === j ? el.fileiraFrente : el.fileiraFundo);
const botaoDe = (j, cor) => fileiraDe(j).querySelector(`.botao[data-cor="${cor}"]`);

/** Acende LEDs por "ms" ms (com som e onda). "jogador" limita a uma fileira. */
function acender(cor, ms, { jogador = null, botoes = null, som = true, efeito = true, anunciarCor = false } = {}) {
  const alvos = botoes || (jogador ? [botaoDe(jogador, cor)] : $$(`.botao[data-cor="${cor}"]`));
  for (const b of alvos) {
    if (!b) continue;
    b.classList.add('aceso');
    if (efeito) onda(b);
    clearTimeout(b._t);
    b._t = setTimeout(() => b.classList.remove('aceso'), ms * ESCALA_TEMPO);
  }
  if (som) Som.cor(cor, ms);
  if (anunciarCor) anunciar(cor);
}
function apertar(botao) {
  if (!botao) return;
  botao.classList.add('apertado');
  clearTimeout(botao._a);
  botao._a = setTimeout(() => botao.classList.remove('apertado'), 140);
}
function apagarTudo() { $$('.botao').forEach((b) => { clearTimeout(b._t); b.classList.remove('aceso', 'correta'); }); }

// ---------------------------------------------------------------------------
// 5. MINI DISPLAY (equivale à classe Tela do Python)
// ---------------------------------------------------------------------------
function bolinhas(feito, total) {
  if (total > 12) return `<span class="barra"><i style="width:${Math.round((100 * feito) / total)}%"></i></span>`;
  let h = '<span class="bolas">';
  for (let i = 0; i < total; i++) h += `<i class="${i < feito ? 'f' : ''}"></i>`;
  return h + '</span>';
}
/** Escreve as 3 linhas do display. "seta" aponta para a fileira do jogador indicado. */
function oled(l1, l2, l3, seta = null) {
  const mudou = el.oled.l2.textContent !== l2;
  el.oled.l1.textContent = l1; el.oled.l2.textContent = l2; el.oled.l3.innerHTML = l3;
  const naFrente = seta && Number(el.fileiraFrente.dataset.jogador) === seta;
  el.oled.baixo.classList.toggle('on', !!seta && naFrente);
  el.oled.cima.classList.toggle('on', !!seta && !naFrente);
  if (mudou) animarClasse(el.oled.caixa, 'troca');
}
const nomeDe = (j) => (P.sala && P.sala.jogadores && P.sala.jogadores[k(j)] ? P.sala.jogadores[k(j)].nome : `Jogador ${j}`);
const curto = (j) => nomeDe(j).slice(0, 10);

// ---------------------------------------------------------------------------
// 6. TELAS, STATUS, REGISTRO E PLACAR
// ---------------------------------------------------------------------------
function mostrarTela(nome) {
  el.corpo.dataset.tela = nome;
  window.scrollTo({ top: 0 });
}
function log(msg) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('pt-BR', { hour12: false })}] ${msg}`;   // formato do log() do Python
  el.log.append(li);
  while (el.log.children.length > 300) el.log.firstElementChild.remove();
  el.log.scrollTop = el.log.scrollHeight;
}
function status(html, tipo = '') {
  el.status.innerHTML = html;
  el.status.classList.toggle('ok', tipo === 'ok');
  el.status.classList.toggle('erro', tipo === 'erro');
}
function anunciar(t) { el.anuncio.textContent = ''; requestAnimationFrame(() => { el.anuncio.textContent = t; }); }
function avisarJogador(j, texto) {
  const c = el.cartoes[j], p = c.querySelector('.aviso-j');
  p.textContent = texto;
  if (!MOVIMENTO_REDUZIDO) animarClasse(c, 'tremer');
  clearTimeout(p._t);
  p._t = setTimeout(() => { p.textContent = ''; }, 1800);
}

/** Atualiza placar, destaques e botões a partir do estado da sala. */
function atualizarPlacar() {
  const s = P.sala || {};
  const j = s.jogo || {};
  const jogando = s.estado === 'jogando';
  for (const n of [1, 2]) {
    const pessoa = s.jogadores && s.jogadores[k(n)];
    el.nomes[n].textContent = pessoa ? pessoa.nome + (P.meu === n ? ' (você)' : '') : 'Aguardando…';
    const naFrente = Number(el.fileiraFrente.dataset.jogador) === n;
    el.lados[n].textContent = P.local ? (n === 1 ? 'fileira da frente · teclas 1–4' : 'fileira do fundo · teclas 5–8')
      : (naFrente ? 'sua fileira (frente) · teclas 1–4' : 'fileira do fundo');
    const daVez = jogando && j.vez === n;
    el.cartoes[n].classList.toggle('da-vez', daVez);
    el.cartoes[n].classList.toggle('esperando', jogando && !daVez);
    el.cartoes[n].classList.toggle('ausente', !pessoa);
    el.cartoes[n].querySelector('.badge-vez').textContent = P.meu && P.meu !== n ? 'VEZ DELE' : 'SUA VEZ';
    fileiraDe(n).classList.toggle('da-vez', daVez && !P.apresentando);
    fileiraDe(n).classList.toggle('esperando', jogando && !daVez);
    fileiraDe(n).classList.toggle('vazia', !pessoa);
    el.pontos[n].textContent = (j.pontos && j.pontos[k(n)]) || 0;
    el.vitorias[n].textContent = (s.placar && s.placar[k(n)]) || 0;
  }
  el.infoRodada.textContent = j.rodada || 0;
  el.infoSeq.textContent = (j.sequencia || []).length;
  el.infoRecorde.textContent = prefs.recorde;
  const bloqueado = jogando || P.apresentando;
  el.corpo.dataset.estado = P.apresentando ? ESTADOS.EXIBINDO : jogando ? ESTADOS.VEZ_DO_JOGADOR : s.estado === 'fim' ? ESTADOS.GAME_OVER : ESTADOS.AGUARDANDO_START;
  el.rever.disabled = bloqueado || !P.ultimaSequencia.length;
  // Botão INICIAR do site: o texto e a cor dizem o que ele faz agora
  const completa = !!(s.jogadores && s.jogadores.j1 && s.jogadores.j2);
  const [estadoBtn, textoBtn] = jogando
    ? (P.local ? ['parar', 'PARAR'] : ['jogando', 'PARTIDA EM ANDAMENTO'])
    : !completa ? ['esperando', 'AGUARDANDO ADVERSÁRIO']
    : [s.estado === 'fim' ? 'pronto' : 'pronto', s.estado === 'fim' ? 'JOGAR DE NOVO' : 'INICIAR PARTIDA'];
  el.start.dataset.estado = estadoBtn;
  el.start.querySelector('.start-txt').textContent = textoBtn;
  el.start.setAttribute('aria-label', textoBtn.charAt(0) + textoBtn.slice(1).toLowerCase());
  // progresso
  const total = (j.sequencia || []).length;
  let h = '';
  for (let i = 0; i < total; i++) h += `<i class="${s.estado === 'fim' && j.erro && i === j.erro.posicao ? 'x' : (jogando && !P.apresentando && i < j.posicao ? 'f' : '')}"></i>`;
  el.progresso.innerHTML = h;
  el.progresso.setAttribute('aria-label', total ? `Progresso: ${jogando ? j.posicao : 0} de ${total} cores` : 'Progresso: nenhuma sequência em jogo');
}

// ---------------------------------------------------------------------------
// 7A. ENTRADA E LOBBY
// ---------------------------------------------------------------------------
async function conectar() {
  // window.GENIUS_MODO_LOCAL é usado só pelas capturas automáticas (não mexem no servidor real)
  if (firebaseConfig && firebaseConfig.databaseURL && !window.GENIUS_MODO_LOCAL) {
    try {
      banco = await criarBancoFirebase(firebaseConfig);
    } catch (e) {
      console.warn('Firebase indisponível, usando modo local:', e);
      banco = criarBancoLocal();
      el.avisoModo.hidden = false;
      el.avisoModo.textContent = '⚠ Não foi possível conectar ao servidor online. Usando o modo local de teste.';
    }
  } else {
    banco = criarBancoLocal();
  }
  const online = banco.modo === 'online';
  el.seloModo.textContent = online ? '● Online' : '● Modo local';
  el.seloModo.className = 'selo-modo ' + (online ? 'online' : 'local');
  el.seloModo.title = online ? 'Conectado ao servidor: partidas entre aparelhos e ranking global' : 'Sem servidor configurado: o lobby funciona entre abas deste navegador';
  if (!online && el.avisoModo.hidden && !window.GENIUS_MODO_LOCAL) {
    el.avisoModo.hidden = false;
    el.avisoModo.innerHTML = '<strong>Modo local de teste:</strong> o servidor online ainda não foi configurado. Para testar o lobby, abra este site em <strong>outra aba</strong> com outro nome. Para jogar entre aparelhos, configure o Firebase (veja COMO_PUBLICAR.md).';
  }
}

async function entrar(nome) {
  nome = String(nome || '').trim().replace(/\s+/g, ' ').slice(0, 16);
  if (nome.length < 2) { $('#erro-nome').textContent = 'Digite um nome com pelo menos 2 letras.'; return; }
  $('#erro-nome').textContent = '';
  eu.nome = nome; salvarIdentidade();
  Som.preparar(); Som.entrou();
  await banco.atualizar(`jogadores/${eu.uid}`, { nome, ultimoAcesso: Date.now() });
  abrirLobby();
}

function abrirLobby() {
  fecharPartida();
  $('#lobby-nome').textContent = eu.nome;
  $$('#form-criar input[name="nivel"]').forEach((i) => { i.checked = i.value === prefs.nivel; });
  mostrarTela('lobby');
  pararLobby.forEach((f) => f()); pararLobby = [];
  pararLobby.push(banco.ouvir('salas', renderizarSalas));
  pararLobby.push(banco.ouvir('ranking', renderizarRanking));
}

function renderizarSalas(salas) {
  const agora = Date.now();
  const lista = Object.entries(salas || {})
    .map(([id, s]) => ({ id, ...s }))
    .filter((s) => s.jogadores && (s.jogadores.j1 || s.jogadores.j2) && agora - (s.criadaEm || 0) < 6 * 3600e3)
    .sort((a, b) => (b.criadaEm || 0) - (a.criadaEm || 0));
  const abertas = lista.filter((s) => s.estado !== 'jogando' && !(s.jogadores.j1 && s.jogadores.j2));
  el.contadorSalas.textContent = abertas.length;
  if (!lista.length) {
    el.listaSalas.innerHTML = '<li class="vazio">Nenhuma partida aberta. Crie a sua!</li>';
    return;
  }
  el.listaSalas.innerHTML = lista.slice(0, 12).map((s) => {
    const cheia = s.jogadores.j1 && s.jogadores.j2;
    const dono = (s.jogadores.j1 || s.jogadores.j2).nome;
    const nivel = (G.NIVEIS[s.nivel] || G.NIVEIS.facil).nome;
    const pode = !cheia && s.estado !== 'jogando';
    return `<li class="sala-item ${pode ? '' : 'em-jogo'}"><div><b>${escapar(s.nome)}</b>
      <small><span class="codigo">${escapar(s.id)}</span> · ${escapar(dono)} · ${nivel} · ${cheia ? (s.estado === 'jogando' ? 'em jogo' : 'cheia') : '1/2 jogadores'}</small></div>
      ${pode ? `<button type="button" class="btn btn-primario btn-pequeno" data-entrar="${escapar(s.id)}">Entrar</button>` : '<span class="texto-2 pequeno">—</span>'}</li>`;
  }).join('');
}

function renderizarRanking(rank) {
  const lista = Object.entries(rank || {}).map(([uid, r]) => ({ uid, ...r }))
    .sort((a, b) => (b.vitorias || 0) - (a.vitorias || 0) || (b.recorde || 0) - (a.recorde || 0) || (b.pontos || 0) - (a.pontos || 0));
  if (!lista.length) {
    el.rankingCorpo.innerHTML = '<tr><td colspan="5" class="vazio">Ninguém jogou ainda. Seja o primeiro!</td></tr>';
    el.suaPosicao.textContent = '';
    return;
  }
  const medalha = ['🥇', '🥈', '🥉'];
  el.rankingCorpo.innerHTML = lista.slice(0, 10).map((r, i) => `<tr class="${r.uid === eu.uid ? 'eu' : ''}">
    <td>${i < 3 ? `<span class="medalha" aria-label="${i + 1}º">${medalha[i]}</span>` : i + 1}</td><td>${escapar(r.nome)}</td>
    <td>${r.vitorias || 0}</td><td>${r.recorde || 0}</td><td>${r.partidas || 0}</td></tr>`).join('');
  const pos = lista.findIndex((r) => r.uid === eu.uid);
  el.suaPosicao.textContent = pos >= 0 ? `Sua posição: ${pos + 1}º de ${lista.length} · ${lista[pos].vitorias || 0} vitória(s)` : 'Você ainda não está no ranking: jogue uma partida online!';
}

function gerarCodigo() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem 0/O e 1/I para não confundir
  return Array.from({ length: 5 }, () => letras[Math.floor(Math.random() * letras.length)]).join('');
}

async function criarSala(nomeSala, nivel) {
  let codigo = gerarCodigo();
  for (let i = 0; i < 5 && (await banco.ler(`salas/${codigo}`)); i++) codigo = gerarCodigo();
  const sala = {
    nome: nomeSala || `Sala de ${eu.nome}`, criadaEm: Date.now(), nivel, estado: 'aguardando',
    jogadores: { j1: { uid: eu.uid, nome: eu.nome } }, placar: { j1: 0, j2: 0 },
  };
  await banco.escrever(`salas/${codigo}`, sala);
  banco.aoDesconectar(`salas/${codigo}/jogadores/j1`, null);
  Som.entrou();
  abrirPartida({ store: banco, salaId: codigo, meu: 1, local: false });
}

async function entrarSala(codigo) {
  codigo = String(codigo || '').trim().toUpperCase();
  const erro = $('#erro-codigo');
  erro.textContent = '';
  if (!/^[A-Z0-9]{5}$/.test(codigo)) { erro.textContent = 'O código tem 5 letras/números.'; return; }
  const sala = await banco.ler(`salas/${codigo}`);
  if (!sala || !sala.jogadores) { erro.textContent = 'Partida não encontrada.'; return; }
  const meuLugar = sala.jogadores.j1 && sala.jogadores.j1.uid === eu.uid ? 1 : sala.jogadores.j2 && sala.jogadores.j2.uid === eu.uid ? 2 : null;
  let vaga = meuLugar || (!sala.jogadores.j1 ? 1 : !sala.jogadores.j2 ? 2 : null);
  if (!vaga) { erro.textContent = 'Essa partida já está cheia.'; return; }
  // Reserva a vaga com transação (evita dois jogadores pegarem a mesma)
  const r = await banco.transacao(`salas/${codigo}/jogadores/${k(vaga)}`, (atual) => {
    if (atual && atual.uid !== eu.uid) return undefined;
    return { uid: eu.uid, nome: eu.nome };
  });
  if (r && r.committed === false) { erro.textContent = 'Alguém pegou a vaga antes. Tente outra partida.'; return; }
  banco.aoDesconectar(`salas/${codigo}/jogadores/${k(vaga)}`, null);
  Som.entrou();
  abrirPartida({ store: banco, salaId: codigo, meu: vaga, local: false });
}

async function jogarLocal() {
  const memoria = criarBancoLocal({ persistir: false });
  await memoria.escrever('salas/LOCAL', {
    nome: 'Mesmo aparelho', criadaEm: Date.now(), nivel: prefs.nivel, estado: 'aguardando',
    jogadores: { j1: { uid: 'local1', nome: eu.nome || 'Jogador 1' }, j2: { uid: 'local2', nome: 'Jogador 2' } }, placar: { j1: 0, j2: 0 },
  });
  abrirPartida({ store: memoria, salaId: 'LOCAL', meu: 0, local: true });
}

// ---------------------------------------------------------------------------
// 7B. PARTIDA (sincronizada pelo banco)
// ---------------------------------------------------------------------------
function abrirPartida({ store, salaId, meu, local }) {
  pararLobby.forEach((f) => f()); pararLobby = [];
  Object.assign(P, { store, salaId, meu, local, sala: null, ultimoN: -1, rodadaVista: 0, apresentando: false, jogadoresAntes: null });
  token += 1;
  montarCaixa(meu === 2 ? 2 : 1);           // a minha fileira fica na frente
  el.log.innerHTML = '';
  limparMarcas(); apagarTudo();
  el.infoSala.innerHTML = local ? 'Partida no mesmo aparelho' : `Sala <b>${escapar(salaId)}</b> · passe o código para o adversário`;
  el.dicaStart.textContent = local ? 'Toque na caixa ou em INICIAR · 2× seguidas zeram o placar' : 'Toque na caixa ou em INICIAR quando os 2 estiverem na sala';
  mostrarTela('jogo');
  log(local ? 'partida no mesmo aparelho' : `entrou na sala ${salaId} como jogador ${meu}`);
  P.parar = store.ouvir(`salas/${salaId}`, aoMudarSala);
}

function fecharPartida() {
  if (P.parar) P.parar();
  P.parar = null; P.sala = null; P.salaId = null;
  token += 1; P.apresentando = false;
  if (el.dlgFim.open) el.dlgFim.close();
}

/** Chamado sempre que a sala muda no banco (em qualquer aparelho). */
function aoMudarSala(sala) {
  if (!sala) {   // sala apagada
    if (P.salaId && !P.local) { status('A partida foi encerrada.'); setTimeout(abrirLobby, 1200); }
    return;
  }
  const anterior = P.sala;
  P.sala = sala;
  const j = sala.jogo || {};
  const ev = j.evento || { n: 0 };
  const primeiro = P.ultimoN < 0;

  // Alguém entrou ou saiu da sala
  const agora = sala.jogadores || {};
  if (anterior && !P.local) {
    for (const n of [1, 2]) {
      const antes = anterior.jogadores && anterior.jogadores[k(n)];
      if (!antes && agora[k(n)]) { log(`${agora[k(n)].nome} entrou na sala`); Som.entrou(); if (n !== P.meu) status(`<strong>${escapar(agora[k(n)].nome)}</strong> entrou! Aperte INICIAR para começar`, 'ok'); }
      if (antes && !agora[k(n)]) { log(`${antes.nome} saiu da sala`); Som.saiu(); }
    }
  }
  if (agora.j1 && agora.j2) P.jogadoresAntes = { j1: agora.j1, j2: agora.j2 };

  // W.O.: o adversário saiu no meio da partida -> eu venço
  if (!P.local && sala.estado === 'jogando' && P.meu && !agora[k(outro(P.meu))]) {
    encerrar({ vencedor: P.meu, perdedor: outro(P.meu), motivo: 'saiu' });
  }

  if (primeiro) {
    P.ultimoN = ev.n;
    P.rodadaVista = sala.estado === 'jogando' ? j.rodada : 0;
    telaParada();
  } else if (ev.n > P.ultimoN) {
    P.ultimoN = ev.n;
    tratarEvento(sala, ev);
  } else if (sala.estado !== 'jogando' && !P.apresentando) {
    telaParada();
  }
  atualizarPlacar();
}

/** Display e status quando não há partida rodando. */
function telaParada() {
  const s = P.sala;
  if (!s || s.estado === 'jogando' || s.estado === 'fim') return;
  const completa = s.jogadores && s.jogadores.j1 && s.jogadores.j2;
  if (completa) {
    oled(`${curto(1)} × ${curto(2)}`, 'PRONTOS', 'aperte iniciar');
    if (!el.status.classList.contains('ok')) status('Os 2 jogadores estão na sala. Aperte <strong>INICIAR</strong>!');
  } else {
    oled(`sala ${P.salaId}`, 'AGUARDANDO', 'adversário…');
    status(`Aguardando o adversário… passe o código <strong>${escapar(P.salaId)}</strong>`);
  }
}

function tratarEvento(sala, ev) {
  const j = sala.jogo;
  switch (ev.tipo) {
    case 'inicio':
      token += 1; limparMarcas(); apagarTudo(); fecharDialogo();
      P.rodadaVista = 0;
      log(`começou! ${nomeDe(1)} × ${nomeDe(2)}, velocidade ${(G.NIVEIS[sala.nivel] || G.NIVEIS.facil).nome}`);
      apresentarRodada(sala, ev).catch(ignorarCancelado);
      break;
    case 'aperto':
      if (ev.origem !== CLIENTE) { apertar(botaoDe(ev.jogador, ev.cor)); acender(ev.cor, 220, { jogador: ev.jogador }); }
      log(`  ${nomeDe(ev.jogador)}: ${ev.cor} ok (${j.posicao}/${j.sequencia.length})`);
      oled(`VEZ: ${curto(j.vez)}`, P.meu && P.meu !== j.vez ? 'AGUARDE' : 'SUA VEZ', bolinhas(j.posicao, j.sequencia.length), j.vez);
      if (ev.origem !== CLIENTE) status(`${escapar(nomeDe(ev.jogador))} acertou <strong>${j.posicao}</strong> de <strong>${j.sequencia.length}</strong>…`);
      break;
    case 'nova_rodada':
      if (ev.origem !== CLIENTE) { apertar(botaoDe(ev.jogador, ev.cor)); acender(ev.cor, 220, { jogador: ev.jogador }); }
      log(`  ${nomeDe(ev.jogador)} acertou a sequência (+1 ponto)`);
      apresentarRodada(sala, ev).catch(ignorarCancelado);
      break;
    case 'fim':
      mostrarFim(sala, ev).catch(ignorarCancelado);
      break;
    case 'parado':
      token += 1; P.apresentando = false; apagarTudo(); Som.parar();
      log(`jogo parado no iniciar (rodada ${j.rodada})`);
      oled(`${curto(1)} × ${curto(2)}`, 'PARADO', 'aperte iniciar');
      status('Partida parada. Aperte <strong>INICIAR</strong> para jogar de novo');
      break;
    case 'placar_zerado':
      log('iniciar apertado 2x: placar zerado');
      break;
    default:
      break;
  }
}

/**
 * Apresenta um turno em TODOS os aparelhos: (+1 e passagem de vez) -> pausa ->
 * sequência acesa SÓ NA FILEIRA DE QUEM VAI JOGAR -> libera o jogador da vez.
 */
async function apresentarRodada(sala, ev) {
  const t = ++token;
  const j = sala.jogo;
  P.apresentando = true;
  atualizarPlacar();
  if (ev.tipo === 'inicio') {
    oled('placar zerado', 'COMEÇOU!', `${curto(1)} abre`, 1);
    status(`Preparem-se! <strong>${escapar(nomeDe(1))}</strong> abre a partida`);
    await Giro.alinhar();            // a caixa termina o giro e se alinha na pose de jogo
    await esperar(150, t);
    await animacaoInicio(t);
  } else {
    await esperar(260, t);
    Som.acertou(); maisUm(ev.jogador);
    oled('+1 ponto', 'BOA!', `vez de ${curto(j.vez)}`, j.vez);
    status(`Boa, ${escapar(nomeDe(ev.jogador))}! <strong>+1 ponto</strong>. Agora é a vez de <strong>${escapar(nomeDe(j.vez))}</strong>`, 'ok');
    await esperar(450, t);
    await passarVez(j.vez, t);
    await Giro.alinhar();            // a caixa vira de frente para quem vai jogar
  }
  const total = j.sequencia.length;
  const minha = !P.meu || P.meu === j.vez;
  log(`rodada ${j.rodada}: ${nomeDe(j.vez)} (jogador ${j.vez}), ${plural(total, 'cor', 'cores')}`);
  oled(`rodada ${j.rodada}`, 'OBSERVE', bolinhas(0, total), j.vez);
  status(minha ? `Observe a sequência, <strong>${escapar(nomeDe(j.vez))}</strong>…` : `<strong>${escapar(nomeDe(j.vez))}</strong> vai jogar. Observe a sequência dele…`);
  await esperar(G.temposDaRodada(sala.nivel, total).pausa, t);
  await mostrarSequencia(j.sequencia, j.vez, sala.nivel, t);
  P.apresentando = false;
  P.rodadaVista = j.rodada;
  const atual = P.sala && P.sala.jogo ? P.sala.jogo : j;
  oled(`VEZ: ${curto(j.vez)}`, minha ? 'SUA VEZ' : 'AGUARDE', bolinhas(atual.posicao || 0, total), j.vez);
  status(minha ? `Sua vez, <strong>${escapar(nomeDe(j.vez))}</strong>! Repita ${plural(total, 'cor', 'cores')}` : `Vez de <strong>${escapar(nomeDe(j.vez))}</strong>. Aguarde…`);
  if (minha) anunciar(`Sua vez. Repita ${plural(total, 'cor', 'cores')}.`);
  atualizarPlacar();
}

/** mostrar(sequencia) do Python, acendendo só a fileira do jogador da vez. */
async function mostrarSequencia(seq, jogador, nivel, t) {
  const tempos = G.temposDaRodada(nivel, seq.length);
  for (let i = 0; i < seq.length; i++) {
    acender(seq[i], tempos.aceso, { jogador, anunciarCor: true });
    el.oled.l3.innerHTML = bolinhas(i + 1, seq.length);
    await esperar(tempos.aceso, t);
    apagarTudo();                               // pausa apagada visível (cores repetidas ficam distintas)
    await esperar(tempos.apagado, t);
  }
}

/** passar_vez(): a luz corre pela fileira de quem vai jogar, com as 4 notas de turno. */
async function passarVez(proximo, t) {
  log(`  vez de ${nomeDe(proximo)}`);
  const ordem = G.ordemPassagem(proximo);
  for (let i = 0; i < ordem.length; i++) {
    acender(ordem[i], 110, { jogador: proximo, som: false });
    Som.turno(i, 110);
    await esperar(140, t);
  }
  await esperar(300, t);
}

/** Início: a luz dá a volta na tampa com arpejo e dois bipes. */
async function animacaoInicio(t) {
  const frente = Number(el.fileiraFrente.dataset.jogador);
  const volta = [...el.fileiraFrente.querySelectorAll('.botao'), ...Array.from(el.fileiraFundo.querySelectorAll('.botao'))];
  void frente;
  Som.inicio();
  for (const b of volta) { acender(b.dataset.cor, 90, { botoes: [b], som: false }); await esperar(75, t); }
  G.CORES.forEach((c) => acender(c, 260, { som: false, efeito: false }));
  await esperar(420, t);
}

/** Aperto de um botão (mouse, toque ou teclado). */
function pressionar(cor, quem, botao) {
  Som.preparar();
  apertar(botao);
  const s = P.sala;
  if (!s || s.estado !== 'jogando') { acender(cor, 220, { botoes: [botao] }); return; }   // teste livre
  if (P.meu && quem !== P.meu) { Som.negado(); avisarJogador(quem, 'Essa é a fileira do adversário'); return; }
  const j = s.jogo;
  if (P.apresentando || P.rodadaVista !== j.rodada) { Som.negado(); avisarJogador(quem, 'Aguarde a sequência terminar'); return; }
  if (j.vez !== quem) {           // regra do protótipo: botão fora da vez é ignorado
    Som.negado(); log(`  ${nomeDe(quem)} apertou ${cor} fora da vez, ignorado`);
    avisarJogador(quem, `Não é sua vez! Vez de ${nomeDe(j.vez)}`);
    return;
  }

  // Valida com o núcleo de regras (o mesmo dos testes TDD)
  const estado = {
    modo: 'duelo', nivel: s.nivel, sequencia: j.sequencia.slice(), posicao: j.posicao, rodada: j.rodada,
    jogador: j.vez, estado: ESTADOS.VEZ_DO_JOGADOR, pontos: { 1: j.pontos.j1, 2: j.pontos.j2 },
  };
  const r = G.validarJogada(estado, cor, quem);
  acender(cor, 220, { botoes: [botao], som: r.resultado !== 'erro' });
  const n = (j.evento ? j.evento.n : 0) + 1;
  const base = `salas/${P.salaId}`;

  if (r.resultado === 'acerto') {
    P.store.atualizar(base, { 'jogo/posicao': estado.posicao, 'jogo/evento': { n, tipo: 'aperto', jogador: quem, cor, origem: CLIENTE } });
    status(`Certo! <strong>${r.posicao}</strong> de <strong>${r.total}</strong>`, 'ok');
  } else if (r.resultado === 'sequencia_completa') {
    P.apresentando = true;          // trava até a próxima apresentação
    G.iniciarRodada(estado);        // sorteia +1 cor e passa a vez
    P.store.atualizar(base, {
      'jogo/sequencia': estado.sequencia, 'jogo/rodada': j.rodada + 1, 'jogo/vez': estado.jogador, 'jogo/posicao': 0,
      'jogo/pontos': { j1: estado.pontos[1], j2: estado.pontos[2] },
      'jogo/evento': { n, tipo: 'nova_rodada', jogador: quem, cor, origem: CLIENTE },
    });
  } else if (r.resultado === 'erro') {
    encerrar({ vencedor: outro(quem), perdedor: quem, motivo: 'erro', cor, esperado: r.esperado, posicao: r.posicao });
  }
}

/** Grava o fim da partida (erro, desistência ou adversário que saiu) e atualiza o ranking. */
function encerrar({ vencedor, perdedor, motivo, cor = null, esperado = null, posicao = -1 }) {
  const s = P.sala;
  if (!s || s.estado !== 'jogando') return;
  const j = s.jogo;
  const n = (j.evento ? j.evento.n : 0) + 1;
  s.estado = 'fim';               // evita gravar duas vezes
  P.store.atualizar(`salas/${P.salaId}`, {
    estado: 'fim',
    'jogo/vencedor': vencedor, 'jogo/perdedor': perdedor,
    'jogo/erro': { cor, esperado, posicao },
    'jogo/evento': { n, tipo: 'fim', motivo, jogador: perdedor, cor, origem: CLIENTE },
    [`placar/${k(vencedor)}`]: ((s.placar && s.placar[k(vencedor)]) || 0) + 1,
  });
  if (!P.local) registrarRanking(s, vencedor, j);
}

/** Ranking global: +1 partida para os dois, +1 vitória/derrota, recorde e pontos. */
function registrarRanking(s, vencedor, j) {
  const pessoas = { ...(P.jogadoresAntes || {}), ...(s.jogadores || {}) };
  const tamanho = (j.sequencia || []).length;
  for (const n of [1, 2]) {
    const p = pessoas[k(n)];
    if (!p) continue;
    banco.transacao(`ranking/${p.uid}`, (r) => {
      r = r || { nome: p.nome, vitorias: 0, derrotas: 0, partidas: 0, recorde: 0, pontos: 0 };
      r.nome = p.nome;
      r.partidas = (r.partidas || 0) + 1;
      if (n === vencedor) r.vitorias = (r.vitorias || 0) + 1; else r.derrotas = (r.derrotas || 0) + 1;
      r.recorde = Math.max(r.recorde || 0, tamanho);
      r.pontos = (r.pontos || 0) + ((j.pontos && j.pontos[k(n)]) || 0);
      r.atualizado = Date.now();
      return r;
    }).catch((e) => console.warn('ranking', e));
  }
}

/** Fim de jogo em todos os aparelhos: sinalização, sons, confete e janela. */
async function mostrarFim(sala, ev) {
  const t = ++token;
  P.apresentando = false;
  const j = sala.jogo;
  const venc = j.vencedor, perd = j.perdedor;
  P.ultimaSequencia = j.sequencia.slice();
  if (ev.origem !== CLIENTE && ev.cor) { apertar(botaoDe(perd, ev.cor)); acender(ev.cor, 220, { jogador: perd, som: false }); }

  const tamanho = j.sequencia.length;
  let novoRecorde = false;
  if (P.local || P.meu) {
    if (tamanho > prefs.recorde && ev.motivo === 'erro') { prefs.recorde = tamanho; novoRecorde = true; salvarPrefs(); }
  }
  const euVenci = P.local || P.meu === venc;
  const textoMotivo = ev.motivo === 'erro'
    ? `${nomeDe(perd)} apertou ${String(j.erro.cor).toUpperCase()}, mas era ${String(j.erro.esperado).toUpperCase()} (cor ${j.erro.posicao + 1} de ${tamanho}).`
    : ev.motivo === 'desistencia' ? `${nomeDe(perd)} saiu no meio da partida (desistência).` : `${nomeDe(perd)} se desconectou. Vitória por W.O.`;
  log(`  ${textoMotivo}`);
  log(`  sequência: ${j.sequencia.join(' -> ')}`);
  log(`fim! ${nomeDe(venc)} venceu com ${tamanho} cores (placar ${sala.placar.j1 || 0} x ${sala.placar.j2 || 0})`);

  el.cartoes[perd].classList.add('errou');
  el.cartoes[venc].classList.add('venceu');
  animarClasse(el.vitorias[venc], 'pulo');
  if (ev.motivo === 'erro') {
    animarClasse(fileiraDe(perd), 'errou');
    botaoDe(perd, j.erro.esperado).classList.add('correta');
  }
  oled(`✕ ${curto(perd)} errou`, P.meu ? (euVenci ? 'VITÓRIA!' : 'DERROTA') : `${curto(venc).toUpperCase()} VENCEU`, novoRecorde ? '★ novo recorde ★' : `placar ${sala.placar.j1 || 0} × ${sala.placar.j2 || 0}`, venc);
  status(`✕ ${escapar(textoMotivo)} <strong>${escapar(nomeDe(venc))} venceu!</strong>`, 'erro');
  anunciar(`${nomeDe(venc)} venceu.`);
  atualizarPlacar();

  if (ev.motivo === 'erro') Som.erro();
  if (euVenci) Som.vitoria(ev.motivo === 'erro' ? 1.3 : 0.1); else Som.derrota();
  if (novoRecorde) Som.recorde();
  if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate([120, 60, 220]);

  if (ev.motivo === 'erro') await piscarTudo(t);
  if (euVenci) confete();
  await esperar(300, t);
  abrirFim(sala, textoMotivo, novoRecorde, euVenci);
}

async function piscarTudo(t) {
  for (let i = 0; i < 3; i++) { G.CORES.forEach((c) => acender(c, 260, { som: false, efeito: false })); await esperar(520, t); }
  const j = P.sala && P.sala.jogo;
  if (j && j.erro && j.erro.esperado) botaoDe(j.perdedor, j.erro.esperado).classList.add('correta');
}

function abrirFim(sala, textoMotivo, novoRecorde, euVenci) {
  const j = sala.jogo;
  $('#fim-selo').textContent = P.local ? 'Fim de jogo · mesmo aparelho' : `Fim de jogo · sala ${P.salaId}`;
  $('#fim-titulo').textContent = P.meu ? (euVenci ? '🏆 Você venceu!' : `${nomeDe(j.vencedor)} venceu`) : `🏆 ${nomeDe(j.vencedor)} venceu!`;
  $('#fim-texto').textContent = textoMotivo;
  $('#fim-recorde').hidden = !novoRecorde;
  $('#fim-seq').innerHTML = j.sequencia.map((c, i) => {
    const errou = j.erro && i === j.erro.posicao;
    return `<li class="${c}${errou ? ' erro' : ''}"><span aria-hidden="true">${SIMBOLO[c]}</span> ${c}${errou ? ' (errou aqui)' : ''}</li>`;
  }).join('');
  $('#fim-placar').innerHTML = `
    <div><dt>Pontos</dt><dd>${escapar(curto(1))} ${j.pontos.j1} × ${j.pontos.j2} ${escapar(curto(2))}</dd></div>
    <div><dt>Vitórias na sala</dt><dd>${sala.placar.j1 || 0} × ${sala.placar.j2 || 0}</dd></div>
    <div><dt>Seu recorde</dt><dd>${prefs.recorde} cores</dd></div>`;
  $('#fim-jogar').textContent = P.local ? 'Jogar de novo' : 'Revanche';
  if (!el.dlgFim.open) el.dlgFim.showModal();
}
function fecharDialogo() { if (el.dlgFim.open) el.dlgFim.close(); }
function limparMarcas() { for (const n of [1, 2]) el.cartoes[n].classList.remove('errou', 'venceu'); }

/** INICIAR: começa (ou revanche). No mesmo aparelho: 1× para, 2× seguidas zeram o placar. */
function apertarStart() {
  Som.preparar();
  animarClasse(el.start, 'apertado');
  setTimeout(() => el.start.classList.remove('apertado'), 120);
  const s = P.sala;
  if (!s) return;
  const base = `salas/${P.salaId}`;
  const n = ((s.jogo && s.jogo.evento && s.jogo.evento.n) || 0) + 1;
  const agora = performance.now();
  const duplo = P.local && agora - P.ultimoStart < 600;
  P.ultimoStart = duplo ? 0 : agora;

  if (s.estado === 'jogando' && !duplo) {
    if (P.local) { P.store.atualizar(base, { estado: 'aguardando', 'jogo/evento': { n, tipo: 'parado', origem: CLIENTE } }); return; }
    Som.negado(); status('A partida está em andamento. Para sair, use <strong>← Sair da sala</strong> (conta como derrota).');
    return;
  }
  if (!(s.jogadores && s.jogadores.j1 && s.jogadores.j2)) {
    Som.negado(); status(`Aguardando o adversário… passe o código <strong>${escapar(P.salaId)}</strong>`);
    return;
  }
  const novo = {
    estado: 'jogando',
    jogo: { sequencia: [G.gerarProximaCor()], rodada: 1, vez: 1, posicao: 0, pontos: { j1: 0, j2: 0 }, evento: { n: n + (duplo ? 1 : 0), tipo: 'inicio', origem: CLIENTE } },
  };
  if (duplo) novo.placar = { j1: 0, j2: 0 };
  P.store.atualizar(base, novo);
}

/** Sair da sala: no meio da partida conta como desistência (derrota). */
async function sairDaSala() {
  const s = P.sala;
  if (s && !P.local && P.meu) {
    if (s.estado === 'jogando') encerrar({ vencedor: outro(P.meu), perdedor: P.meu, motivo: 'desistencia' });
    const restante = s.jogadores && s.jogadores[k(outro(P.meu))];
    banco.cancelarDesconexao();
    if (restante) await banco.remover(`salas/${P.salaId}/jogadores/${k(P.meu)}`);
    else await banco.remover(`salas/${P.salaId}`);
  }
  P.salaId = null;
  abrirLobby();
}

/** Reexibe a sequência da última partida, na fileira de quem jogou por último. */
async function reverSequencia() {
  const s = P.sala;
  if (!s || s.estado === 'jogando' || !P.ultimaSequencia.length) return;
  fecharDialogo();
  const t = ++token;
  P.apresentando = true; atualizarPlacar();
  oled('última sequência', 'REVER', `${P.ultimaSequencia.length} cores`);
  status(`Revendo a última sequência (${plural(P.ultimaSequencia.length, 'cor', 'cores')})…`);
  try {
    await esperar(500, t);
    await mostrarSequencia(P.ultimaSequencia, s.jogo ? s.jogo.perdedor || 1 : 1, s.nivel, t);
    status(`Sequência: ${P.ultimaSequencia.map((c) => `${SIMBOLO[c]} ${c}`).join(', ')}`);
  } catch (e) { ignorarCancelado(e); }
  P.apresentando = false; atualizarPlacar();
}

// ---------------------------------------------------------------------------
// 8. EVENTOS DE CLIQUE, TOQUE E TECLADO
// ---------------------------------------------------------------------------
/** pointerdown = resposta imediata (sem atraso de 300 ms); click com detail 0 = teclado. Um evento por aperto. */
function ligarBotao(botao, acao) {
  botao.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); acao();
  });
  botao.addEventListener('click', (e) => { if (e.detail === 0) acao(); });
  botao.addEventListener('contextmenu', (e) => e.preventDefault());
}
ligarBotao(el.start, apertarStart);

const TECLAS = { 1: ['1', '2', '3', '4', 'q', 'w', 'e', 'r'], 2: ['5', '6', '7', '8', 'u', 'i', 'o', 'p'] };
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (el.dlgFim.open || el.dlgAjuda.open || el.dlgVisual.open) return;
  if (e.target.closest && e.target.closest('input, textarea')) return;       // digitando nome/código
  const emControle = e.target.closest && e.target.closest('button, summary, a');
  const tecla = e.key.toLowerCase();
  if (tecla === 'm') { alternarSom(); return; }
  if (tecla === 't') { alternarTema(); return; }
  if (tecla === 'h' || tecla === '?') { abrirAjuda(); return; }
  if (el.corpo.dataset.tela !== 'jogo') return;
  if (tecla === ' ' || tecla === 'enter') { if (emControle) return; e.preventDefault(); apertarStart(); return; }
  if (tecla === 'v') { reverSequencia(); return; }
  for (const n of [1, 2]) {
    const i = TECLAS[n].indexOf(tecla);
    if (i < 0) continue;
    e.preventDefault();
    const cor = G.CORES[i % 4];
    const jogador = P.local ? n : (P.meu || 1);   // online: as teclas 1–4 são sempre da SUA fileira
    pressionar(cor, jogador, botaoDe(jogador, cor));
    return;
  }
});

// Configurações
function aplicarSom() {
  el.som.setAttribute('aria-pressed', String(prefs.som));
  el.som.setAttribute('aria-label', prefs.som ? 'Som ligado' : 'Som desligado');
  el.volume.value = prefs.volume;
  el.volumeValor.textContent = `${prefs.volume}%`;
}
function alternarSom() { prefs.som = !prefs.som; salvarPrefs(); aplicarSom(); if (prefs.som) Som.clique(); }
/** Temas visuais: material da caixa, textura dos botões e fundo do site. */
const VISUAIS = ['classico', 'neon', 'madeira', 'metal', 'papel'];
function aplicarTema() {
  const v = VISUAIS.includes(prefs.visual) ? prefs.visual : 'classico';
  document.documentElement.dataset.visual = v;
  document.documentElement.dataset.tema = v === 'papel' ? 'claro' : 'escuro';   // cores da interface
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = v === 'papel' ? '#eef1f7' : '#0a1222';
  $$('.visual-opcao').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.visual === v)));
}
function escolherVisual(v) { prefs.visual = v; salvarPrefs(); aplicarTema(); Som.clique(); }
/** Atalho T: passa para o próximo tema. */
function alternarTema() { escolherVisual(VISUAIS[(VISUAIS.indexOf(prefs.visual) + 1) % VISUAIS.length]); }
function abrirVisual() { Som.clique(); aplicarTema(); if (!el.dlgVisual.open) el.dlgVisual.showModal(); }
function abrirAjuda() { Som.clique(); if (!el.dlgAjuda.open) el.dlgAjuda.showModal(); }

el.som.addEventListener('click', alternarSom);
el.tema.addEventListener('click', abrirVisual);
$$('.visual-opcao').forEach((b) => b.addEventListener('click', () => escolherVisual(b.dataset.visual)));
$('#visual-fechar').addEventListener('click', () => el.dlgVisual.close());
el.ajuda.addEventListener('click', abrirAjuda);
el.volume.addEventListener('input', () => { prefs.volume = Number(el.volume.value); el.volumeValor.textContent = `${prefs.volume}%`; Som.volume(); });
el.volume.addEventListener('change', () => { salvarPrefs(); Som.preparar(); Som.cor('vermelho', 180); });
el.rever.addEventListener('click', reverSequencia);
$('#btn-sair').addEventListener('click', () => { Som.clique(); sairDaSala(); });
$('#btn-trocar-nome').addEventListener('click', () => { $('#campo-nome').value = eu.nome; mostrarTela('entrada'); $('#campo-nome').focus(); });
$('#btn-local').addEventListener('click', () => { Som.preparar(); Som.clique(); jogarLocal(); });
$('#form-nome').addEventListener('submit', (e) => { e.preventDefault(); entrar($('#campo-nome').value); });
$('#form-criar').addEventListener('submit', (e) => {
  e.preventDefault(); Som.preparar();
  const nivel = ($('#form-criar input[name="nivel"]:checked') || {}).value || 'facil';
  prefs.nivel = nivel; salvarPrefs();
  criarSala($('#campo-sala').value.trim().slice(0, 24), nivel);
});
$('#form-codigo').addEventListener('submit', (e) => { e.preventDefault(); Som.preparar(); entrarSala($('#campo-codigo').value); });
el.listaSalas.addEventListener('click', (e) => { const b = e.target.closest('[data-entrar]'); if (b) { Som.preparar(); entrarSala(b.dataset.entrar); } });
$('#fim-jogar').addEventListener('click', () => { fecharDialogo(); apertarStart(); });
$('#fim-rever').addEventListener('click', reverSequencia);
$('#fim-lobby').addEventListener('click', () => { fecharDialogo(); sairDaSala(); });
$('#ajuda-fechar').addEventListener('click', () => el.dlgAjuda.close());
[el.dlgFim, el.dlgAjuda, el.dlgVisual].forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

// ---------------------------------------------------------------------------
// 8B. GIRO DA CAIXA 3D
// Antes de começar a caixa gira devagar, balançando de leve. Quando a partida
// começa ela desacelera e PARA DE FRENTE PARA QUEM VAI JOGAR: se a vez é de
// quem está na fileira da frente, fica de frente (0°); se é da fileira do
// fundo, dá meia-volta (180°) e a fileira dele vem para a frente.
// ---------------------------------------------------------------------------
const POSE_JOGO = { rx: 38 };
/** Ângulo em que a caixa deve parar agora: de frente para o jogador da vez. */
function anguloDaVez() {
  const s = P.sala;
  if (!s || s.estado !== 'jogando' || !s.jogo) return 0;
  return s.jogo.vez === Number(el.fileiraFrente.dataset.jogador) ? 0 : 180;
}
const normal = (a) => ((a % 360) + 360) % 360;
const Giro = {
  rx: POSE_JOGO.rx, rz: 0, bob: 0, vel: 0, ultimo: 0,
  tween: null,            // movimento em andamento: { alvo, de, ate, rxDe, bobDe, ini, dur }
  esperando: [],          // promessas aguardando a caixa parar alinhada
  deveGirar() {
    if (MOVIMENTO_REDUZIDO || el.corpo.dataset.tela !== 'jogo') return false;
    if (P.apresentando || el.dlgFim.open) return false;
    return !P.sala || P.sala.estado !== 'jogando';
  },
  quadro(t) {
    const dt = this.ultimo ? Math.min(48, t - this.ultimo) : 16;
    this.ultimo = t;
    const girar = this.deveGirar();
    el.palco.classList.toggle('girando', girar);
    if (girar) {
      this.tween = null;
      this.vel = Math.min(this.vel + dt * 0.00004, 0.024);          // acelera suave até ~24°/s
      this.rz += this.vel * dt;
      const rxAlvo = 54 + Math.sin(t / 1400) * 5;                   // balanço leve
      this.rx += (rxAlvo - this.rx) * Math.min(1, dt / 500);
      this.bob = Math.sin(t / 900) * 6;
    } else {
      const alvo = anguloDaVez();
      if (this.alinhada(alvo)) {
        this.rz = alvo; this.rx = POSE_JOGO.rx; this.bob = 0; this.tween = null; this.vel = 0;
        this.avisar();
      } else {
        if (!this.tween || this.tween.alvo !== alvo) {
          let falta = normal(alvo - this.rz);                         // quanto falta, no sentido do giro
          if (this.vel > 0.004) { if (falta < 90) falta += 360; }     // vindo do giro: continua no mesmo sentido
          else if (falta > 180) falta -= 360;                         // parada: caminho mais curto
          this.tween = { alvo, de: this.rz, ate: this.rz + falta, rxDe: this.rx, bobDe: this.bob, ini: t, dur: 650 + Math.abs(falta) * 1.5 };
        }
        const w = this.tween;
        const k = Math.min(1, (t - w.ini) / w.dur);
        const e = k < 0.5 && this.vel === 0 && w.de !== w.ate && Math.abs(w.ate - w.de) <= 180
          ? 4 * k * k * k : 1 - Math.pow(1 - k, 3);                    // meia-volta: acelera e freia; fim do giro: só freia
        this.rz = w.de + (w.ate - w.de) * e;
        this.rx = w.rxDe + (POSE_JOGO.rx - w.rxDe) * e;
        this.bob = w.bobDe * (1 - e);
        if (k >= 1) { this.rz = alvo; this.rx = POSE_JOGO.rx; this.bob = 0; this.tween = null; this.vel = 0; this.avisar(); }
        else if (this.vel > 0) this.vel = Math.max(0, this.vel - dt * 0.0001);
      }
    }
    // Virada (fileira do fundo na frente): display e números giram para continuar legíveis
    const ang = normal(this.rz);
    el.caixa.classList.toggle('virada', ang > 90 && ang < 270);
    el.caixa.style.transform = `translateY(${this.bob.toFixed(2)}px) rotateX(${this.rx.toFixed(2)}deg) rotateZ(${this.rz.toFixed(2)}deg)`;
    requestAnimationFrame((n) => this.quadro(n));
  },
  alinhada(alvo = anguloDaVez()) {
    const d = normal(this.rz - alvo);
    return !this.tween && Math.abs(this.rx - POSE_JOGO.rx) < 0.05 && (d < 0.05 || d > 359.95);
  },
  avisar() { if (this.esperando.length) this.esperando.splice(0).forEach((f) => f()); },
  /** Resolve quando a caixa estiver parada de frente para o jogador da vez (no máximo ~2,6 s). */
  alinhar() {
    if (this.alinhada()) return Promise.resolve();
    return new Promise((ok) => { this.esperando.push(ok); setTimeout(ok, 2600); });
  },
};

// Tocar na caixa girando = apertar INICIAR (fica fácil de começar no celular)
el.palco.addEventListener('pointerdown', (e) => {
  if (!el.palco.classList.contains('girando') || e.target.closest('#btn-start')) return;
  e.preventDefault();
  apertarStart();
});

/** Copia a caixa 3D para a tela de entrada, como enfeite girando. */
function montarMiniCaixa() {
  const copia = el.palco.cloneNode(true);
  copia.removeAttribute('id');
  copia.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  copia.querySelectorAll('button').forEach((b) => { b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); });
  copia.querySelector('.caixa3d').style.transform = '';
  copia.querySelector('.oled-l2').textContent = 'SHUFFLE';
  const alvo = $('#mini-palco');
  alvo.innerHTML = '';
  alvo.append(copia);
}

// ---------------------------------------------------------------------------
// 9. INICIALIZAÇÃO
// ---------------------------------------------------------------------------
aplicarSom();
aplicarTema();
montarCaixa(1);
montarMiniCaixa();
requestAnimationFrame((t) => Giro.quadro(t));
await conectar();
carregarIdentidade(banco.modo !== 'online');
if (eu.nome) { $('#campo-nome').value = eu.nome; abrirLobby(); } else { mostrarTela('entrada'); $('#campo-nome').focus(); }

// Exposto só para depuração e testes automatizados
window.GeniusApp = { P, prefs, eu, Giro, escolherVisual, entrar, criarSala, entrarSala, jogarLocal, apertarStart, pressionar, sairDaSala, abrirLobby, botaoDe };

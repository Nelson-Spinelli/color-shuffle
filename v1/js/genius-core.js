/* =============================================================================
 * COLOR SHUFFLE — NÚCLEO DE REGRAS DO GENIUS MULTIPLAYER (genius-core.js)
 * -----------------------------------------------------------------------------
 * Este arquivo contém SOMENTE a lógica do jogo (máquina de estados), sem
 * nenhuma linha de HTML, CSS ou som. Por isso ele pode ser:
 *   - usado no navegador (fica disponível como window.GeniusCore);
 *   - testado no Node.js com testes automatizados (TDD: tests/*.test.js).
 *
 * As regras são as MESMAS do protótipo físico (Raspberry Pi, "jogo genius.py"):
 *   1. A sequência é uma só e vale para os dois jogadores.
 *   2. O Jogador 1 abre a partida. A cada turno entra +1 cor nova no fim.
 *   3. Só os botões do jogador da vez valem; os do adversário são ignorados.
 *   4. Acertou a sequência inteira: +1 ponto e a vez passa ao adversário.
 *   5. Errou: a partida acaba e o ADVERSÁRIO vence (placar de vitórias +1).
 *   6. A sequência não tem tamanho máximo. Recorde = maior sequência jogada.
 * ========================================================================== */
(function (raiz, fabrica) {
  'use strict';
  const api = fabrica();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;          // Node.js (testes automatizados)
  } else {
    raiz.GeniusCore = api;         // Navegador (window.GeniusCore)
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. CONSTANTES DO JOGO
  // ---------------------------------------------------------------------------

  // As 4 cores, na mesma ordem dos botões do protótipo (B1..B4 / B5..B8).
  const CORES = Object.freeze(['vermelho', 'amarelo', 'verde', 'azul']);

  // Estados possíveis da máquina de estados do jogo.
  const ESTADOS = Object.freeze({
    AGUARDANDO_START: 'AGUARDANDO_START', // tela inicial, esperando "Iniciar"
    EXIBINDO: 'EXIBINDO',                 // o jogo está mostrando a sequência (entrada bloqueada)
    VEZ_DO_JOGADOR: 'VEZ_DO_JOGADOR',     // o jogador da vez está repetindo a sequência
    PASSANDO_VEZ: 'PASSANDO_VEZ',         // sequência completa; animação de troca de turno
    GAME_OVER: 'GAME_OVER',               // alguém errou; partida encerrada
    PARADO: 'PARADO',                     // partida interrompida pelo botão Iniciar
  });

  // Modos de jogo: o duelo reproduz o protótipo; o solo é o Genius clássico.
  const MODOS = Object.freeze({ DUELO: 'duelo', SOLO: 'solo' });

  // Níveis de velocidade (em milissegundos).
  // "Fácil" é mais lento que o protótipo (bom para iniciantes e acessibilidade).
  // "Médio" usa EXATAMENTE os tempos do código do Raspberry Pi:
  //   TEMPO_ACESO = 0.5 s, TEMPO_APAGADO = 0.25 s e PAUSA_VEZ = 1.0 s.
  const NIVEIS = Object.freeze({
    facil:   Object.freeze({ nome: 'Fácil',   aceso: 750, apagado: 400, pausa: 1300 }),
    medio:   Object.freeze({ nome: 'Médio',   aceso: 500, apagado: 250, pausa: 1000 }),
    dificil: Object.freeze({ nome: 'Difícil', aceso: 340, apagado: 200, pausa: 800 }),
  });

  // Menor pausa com o LED apagado entre duas cores: garante que cores
  // repetidas (ex.: azul, azul) apareçam como DOIS piscos separados.
  const APAGADO_MINIMO = 200;

  // Tempo que o botão fica aceso quando o jogador aperta (TEMPO_TOQUE = 0.15 s).
  const TEMPO_TOQUE = 150;

  // ---------------------------------------------------------------------------
  // 2. FUNÇÕES PURAS AUXILIARES
  // ---------------------------------------------------------------------------

  /** Sorteia uma cor. "rng" pode ser injetado nos testes para ficar previsível. */
  function gerarProximaCor(rng = Math.random) {
    const indice = Math.floor(rng() * CORES.length);
    // Math.min protege contra um rng que devolva exatamente 1.
    return CORES[Math.min(Math.max(indice, 0), CORES.length - 1)];
  }

  /** Devolve o outro jogador (1 -> 2, 2 -> 1). */
  function outroJogador(jogador) {
    return jogador === 1 ? 2 : 1;
  }

  /** Lado da tela de cada jogador (igual ao dicionário LADO do Python). */
  function ladoDoJogador(jogador) {
    return jogador === 1 ? 'esquerda' : 'direita';
  }

  /**
   * Tempos da rodada: a cada 5 cores o jogo fica 5% mais rápido,
   * até no máximo 20% mais rápido (fator mínimo 0,8). O aumento é suave
   * para o desafio crescer sem ficar impossível de acompanhar, e o LED
   * apagado nunca dura menos que APAGADO_MINIMO.
   */
  function temposDaRodada(nivel, tamanhoSequencia) {
    const base = NIVEIS[nivel] || NIVEIS.facil;
    const degraus = Math.floor(Math.max(tamanhoSequencia - 1, 0) / 5);
    const fator = Math.max(0.8, Math.round((1 - 0.05 * degraus) * 100) / 100);
    return {
      aceso: Math.round(base.aceso * fator),
      apagado: Math.max(APAGADO_MINIMO, Math.round(base.apagado * fator)),
      pausa: base.pausa,
      fator,
    };
  }

  /**
   * Ordem das luzes na animação de "passar a vez": as luzes correm em
   * direção ao lado de quem vai jogar (como passar_vez() no Python).
   */
  function ordemPassagem(proximoJogador) {
    const paraDireita = ['amarelo', 'verde', 'vermelho', 'azul'];
    return proximoJogador === 2 ? paraDireita : paraDireita.slice().reverse();
  }

  // ---------------------------------------------------------------------------
  // 3. CRIAÇÃO E REINÍCIO DO ESTADO DO JOGO
  // ---------------------------------------------------------------------------

  /** Cria um objeto de jogo novo, já no estado inicial. */
  function criarJogo(opcoes = {}) {
    const jogo = {
      modo: opcoes.modo === MODOS.SOLO ? MODOS.SOLO : MODOS.DUELO,
      nivel: NIVEIS[opcoes.nivel] ? opcoes.nivel : 'facil',
    };
    return resetarJogo(jogo);
  }

  /** Zera a partida (sequência, rodada, pontos) e volta a "Aguardando Start". */
  function resetarJogo(jogo) {
    jogo.sequencia = [];           // sequência sorteada pelo sistema
    jogo.posicao = 0;              // quantas cores o jogador da vez já acertou
    jogo.rodada = 0;               // número do turno atual
    jogo.jogador = 1;              // o Jogador 1 sempre abre a partida
    jogo.pontos = { 1: 0, 2: 0 };  // +1 ponto por sequência acertada (nesta partida)
    jogo.estado = ESTADOS.AGUARDANDO_START;
    jogo.vencedor = null;
    jogo.perdedor = null;
    jogo.erro = null;              // detalhes do erro: { cor, esperado, posicao }
    return jogo;
  }

  // ---------------------------------------------------------------------------
  // 4. TRANSIÇÕES DA MÁQUINA DE ESTADOS
  // ---------------------------------------------------------------------------

  /**
   * Começa um novo turno: sorteia +1 cor, incrementa a rodada e bloqueia a
   * entrada (estado EXIBINDO). Devolve a cor sorteada.
   */
  function iniciarRodada(jogo, rng = Math.random) {
    const permitidos = [ESTADOS.AGUARDANDO_START, ESTADOS.PASSANDO_VEZ];
    if (!permitidos.includes(jogo.estado)) {
      throw new Error(`Não é possível iniciar rodada no estado ${jogo.estado}`);
    }
    const cor = gerarProximaCor(rng);
    jogo.sequencia.push(cor);
    jogo.rodada += 1;
    jogo.posicao = 0;
    jogo.estado = ESTADOS.EXIBINDO;
    return cor;
  }

  /** Fim da demonstração: libera os botões para o jogador da vez. */
  function liberarJogador(jogo) {
    if (jogo.estado !== ESTADOS.EXIBINDO) return false;
    jogo.estado = ESTADOS.VEZ_DO_JOGADOR;
    return true;
  }

  /**
   * Valida um aperto de botão.
   * @param jogo     objeto do jogo
   * @param cor      cor apertada
   * @param jogador  quem apertou (1 ou 2). Se omitido, assume o jogador da vez.
   * @returns objeto { resultado, ... } onde resultado é:
   *   'bloqueado'           -> o jogo não está esperando jogada (ex.: exibindo)
   *   'invalido'            -> cor inexistente
   *   'fora_da_vez'         -> botão do adversário (ignorado, como no protótipo)
   *   'acerto'              -> cor certa, mas a sequência ainda não acabou
   *   'sequencia_completa'  -> acertou tudo: +1 ponto e troca de turno
   *   'erro'                -> errou: GAME_OVER e o adversário vence
   */
  function validarJogada(jogo, cor, jogador = jogo.jogador) {
    if (jogo.estado !== ESTADOS.VEZ_DO_JOGADOR) {
      return { resultado: 'bloqueado' };
    }
    if (!CORES.includes(cor)) {
      return { resultado: 'invalido' };
    }
    if (jogo.modo === MODOS.DUELO && jogador !== jogo.jogador) {
      return { resultado: 'fora_da_vez', jogador, cor };
    }

    const esperado = jogo.sequencia[jogo.posicao];
    const total = jogo.sequencia.length;

    if (cor !== esperado) {
      jogo.estado = ESTADOS.GAME_OVER;
      jogo.perdedor = jogo.jogador;
      jogo.vencedor = jogo.modo === MODOS.DUELO ? outroJogador(jogo.jogador) : null;
      jogo.erro = { cor, esperado, posicao: jogo.posicao };
      return { resultado: 'erro', cor, esperado, posicao: jogo.posicao, total };
    }

    jogo.posicao += 1;
    if (jogo.posicao < total) {
      return { resultado: 'acerto', posicao: jogo.posicao, total };
    }

    // Sequência completa: +1 ponto para o jogador da vez.
    const quemAcertou = jogo.jogador;
    jogo.pontos[quemAcertou] += 1;
    if (jogo.modo === MODOS.DUELO) {
      jogo.jogador = outroJogador(quemAcertou);
    }
    jogo.estado = ESTADOS.PASSANDO_VEZ;
    return {
      resultado: 'sequencia_completa',
      total,
      jogador: quemAcertou,
      proximoJogador: jogo.jogador,
    };
  }

  /** Interrompe a partida (botão Iniciar apertado durante o jogo). */
  function pararJogo(jogo) {
    if (jogo.estado === ESTADOS.AGUARDANDO_START || jogo.estado === ESTADOS.GAME_OVER) {
      return false;
    }
    jogo.estado = ESTADOS.PARADO;
    return true;
  }

  /** Indica se há uma partida em andamento (para bloquear configurações). */
  function emAndamento(jogo) {
    return [ESTADOS.EXIBINDO, ESTADOS.VEZ_DO_JOGADOR, ESTADOS.PASSANDO_VEZ].includes(jogo.estado);
  }

  // ---------------------------------------------------------------------------
  // 5. PLACAR E RECORDE
  // ---------------------------------------------------------------------------

  /**
   * Tamanho da sequência que valeu na partida (usado no recorde e na
   * mensagem "venceu com N cores", como no Python: total = len(sequencia)).
   */
  function tamanhoFinal(jogo) {
    return jogo.sequencia.length;
  }

  /** Quantas sequências completas foram acertadas (pontuação do modo solo). */
  function sequenciasAcertadas(jogo) {
    return jogo.pontos[1] + jogo.pontos[2];
  }

  /** Atualiza o recorde: devolve { recorde, novo } sem alterar o original. */
  function atualizarRecorde(recordeAtual, valor) {
    const atual = Number.isFinite(recordeAtual) ? recordeAtual : 0;
    return valor > atual ? { recorde: valor, novo: true } : { recorde: atual, novo: false };
  }

  /** Soma +1 vitória ao vencedor no placar geral (sem alterar o objeto original). */
  function registrarVitoria(placar, vencedor) {
    const novo = { 1: placar[1] || 0, 2: placar[2] || 0 };
    if (vencedor === 1 || vencedor === 2) novo[vencedor] += 1;
    return novo;
  }

  // ---------------------------------------------------------------------------
  // 6. API PÚBLICA
  // ---------------------------------------------------------------------------
  return Object.freeze({
    CORES, ESTADOS, MODOS, NIVEIS, TEMPO_TOQUE, APAGADO_MINIMO,
    gerarProximaCor, outroJogador, ladoDoJogador, temposDaRodada, ordemPassagem,
    criarJogo, resetarJogo, iniciarRodada, liberarJogador, validarJogada,
    pararJogo, emAndamento, tamanhoFinal, sequenciasAcertadas,
    atualizarRecorde, registrarVitoria,
  });
});

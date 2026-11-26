/* =============================================================================
 * COLOR SHUFFLE — CONFIGURAÇÃO DO FIREBASE (modo online)
 * -----------------------------------------------------------------------------
 * Configuração do projeto Firebase "color-shuffle" (modo ONLINE ativo).
 * Se este objeto voltar a ser null, o jogo roda em MODO LOCAL DE TESTE
 * (o lobby funciona entre abas do mesmo navegador).
 *
 * Para jogar online de verdade (aparelhos diferentes + ranking global):
 *   1. Crie um projeto em https://console.firebase.google.com
 *   2. Crie um "Realtime Database" e cole as regras do arquivo database.rules.json
 *   3. Em Configurações do projeto > Seus apps > Web (</>), copie o firebaseConfig
 *   4. Substitua o null abaixo pelo objeto copiado (precisa ter databaseURL)
 * Passo a passo completo: COMO_PUBLICAR.md
 * ========================================================================== */
export const firebaseConfig = {
  apiKey: "AIzaSyAigIzlL4LDMhLo9jLNFztD7aMX1aMk7W4",
  authDomain: "color-shuffle.firebaseapp.com",
  databaseURL: "https://color-shuffle-default-rtdb.firebaseio.com",
  projectId: "color-shuffle",
  storageBucket: "color-shuffle.firebasestorage.app",
  messagingSenderId: "1078492283280",
  appId: "1:1078492283280:web:0fd2b886bf8c2713313315"
};

/* Exemplo do formato (NÃO use estes valores, são fictícios):
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "color-shuffle-xxxx.firebaseapp.com",
  databaseURL: "https://color-shuffle-xxxx-default-rtdb.firebaseio.com",
  projectId: "color-shuffle-xxxx",
  storageBucket: "color-shuffle-xxxx.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxx"
};
*/

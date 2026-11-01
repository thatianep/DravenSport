// Conexão com WhatsApp por QR Code (mesmo mecanismo do WhatsApp Web), usando a biblioteca Baileys.
// Cada número conectado vira um canal: toda pessoa que conversar com ele entra no CRM como lead, já classificada.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const TIPOS = ['Academia', 'Equipe/Time', 'Escolinha de futebol', 'Loja', 'Distribuidor', 'Atleta', 'Outro'];
const SILENT = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return SILENT; } };
const cut = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// chave de telefone: DDD + 8 últimos dígitos (casa números com e sem o nono dígito)
export function telKey(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.length >= 10 ? d.slice(0, 2) + d.slice(-8) : d;
}
export function fmtTel(t) {
  let d = String(t || '').replace(/\D/g, ''); if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return t;
}
// classificação por palavras-chave do nome do perfil e da primeira mensagem
export function classificar(texto) {
  const t = norm(texto);
  const tem = (...w) => w.some(x => t.includes(x));
  let tipo = 'Outro';
  if (tem('distribui', 'atacad', 'revend', 'revenda', 'cnpj', 'lojista')) tipo = 'Distribuidor';
  else if (tem('escolinha', 'futebol', ' fc', 'futsal', 'society', 'goleiro', 'sub-1', 'sub 1')) tipo = 'Escolinha de futebol';
  else if (tem('academia', ' ct ', 'ct ', 'dojo', 'crossfit', 'fight', 'boxe', 'muay', 'jiu', 'bjj', 'mma', 'karate', 'judo', 'taekwondo', 'kickbox')) tipo = 'Academia';
  else if (tem('equipe', 'team', 'time ', 'clube')) tipo = 'Equipe/Time';
  else if (tem('loja', 'store', 'esportes', 'sports shop', 'magazine')) tipo = 'Loja';
  else if (tem('atleta', 'lutador', 'competi')) tipo = 'Atleta';
  const mapa = [['luva de goleiro', 'Luvas de goleiro'], ['goleiro', 'Luvas de goleiro'], ['luva', 'Luvas de luta'], ['kimono', 'Kimonos'], ['faixa', 'Faixas'], ['caneleira', 'Caneleiras'],
    ['bandagem', 'Bandagens'], ['protetor', 'Protetores'], ['bucal', 'Protetor bucal'], ['saco de pancada', 'Sacos de pancada'], ['aparador', 'Aparadores'], ['manopla', 'Manoplas'],
    ['camisa', 'Vestuário'], ['shorts', 'Vestuário'], ['rashguard', 'Vestuário'], ['personaliz', 'Marca própria'], ['logo', 'Marca própria'], ['marca propria', 'Marca própria'], ['atacado', 'Atacado']];
  const interesse = [...new Set(mapa.filter(([k]) => t.includes(k)).map(([, v]) => v))].join(', ');
  return { tipo, interesse };
}
function extrair(mm) {
  if (!mm) return null;
  for (const k of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage', 'editedMessage']) if (mm[k]?.message) mm = mm[k].message;
  if (mm.conversation) return { texto: mm.conversation, tipo: 'texto' };
  if (mm.extendedTextMessage?.text) return { texto: mm.extendedTextMessage.text, tipo: 'texto' };
  if (mm.imageMessage) return { texto: ('[Imagem] ' + (mm.imageMessage.caption || '')).trim(), tipo: 'imagem' };
  if (mm.videoMessage) return { texto: ('[Vídeo] ' + (mm.videoMessage.caption || '')).trim(), tipo: 'video' };
  if (mm.audioMessage) return { texto: '[Áudio]', tipo: 'audio' };
  if (mm.documentMessage) return { texto: ('[Documento] ' + (mm.documentMessage.fileName || '')).trim(), tipo: 'documento' };
  if (mm.stickerMessage) return { texto: '[Figurinha]', tipo: 'figurinha' };
  if (mm.locationMessage) return { texto: '[Localização]', tipo: 'localizacao' };
  if (mm.contactMessage) return { texto: '[Contato] ' + (mm.contactMessage.displayName || ''), tipo: 'contato' };
  if (mm.buttonsResponseMessage?.selectedDisplayText) return { texto: mm.buttonsResponseMessage.selectedDisplayText, tipo: 'texto' };
  if (mm.listResponseMessage?.title) return { texto: mm.listResponseMessage.title, tipo: 'texto' };
  return null;
}
const safeId = s => String(s || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 120) || null;

// biblioteca falsa para testes sem celular (WA_FAKE=1)
function fakeLib() {
  return {
    make() {
      const ev = new EventEmitter();
      const sock = { ev, user: null, async sendMessage() { return { key: { id: 'FAKE' + Math.random().toString(36).slice(2, 12).toUpperCase() } }; }, async logout() {}, end() {} };
      setTimeout(() => ev.emit('connection.update', { qr: '2@FAKE-QR-' + Date.now() }), 300);
      setTimeout(() => { sock.user = { id: '5511999990000:7@s.whatsapp.net', name: 'Draven Teste' }; ev.emit('connection.update', { connection: 'open' }); }, 2500);
      return sock;
    },
    async useMultiFileAuthState() { return { state: {}, saveCreds() {} }; },
    DisconnectReason: { loggedOut: 401, timedOut: 408 },
  };
}

export function createWhatsApp({ store, rid, dataDir, ai, fake }) {
  const sessions = new Map();
  let lib = null, libErr = null;
  async function load() {
    if (lib || libErr) return lib;
    if (fake) return (lib = fakeLib());
    try {
      const m = await import('@whiskeysockets/baileys');
      const make = [m.default?.default, m.default, m.makeWASocket].find(f => typeof f === 'function');
      lib = { make, useMultiFileAuthState: m.useMultiFileAuthState, DisconnectReason: m.DisconnectReason || { loggedOut: 401, timedOut: 408 }, fetchLatestBaileysVersion: m.fetchLatestBaileysVersion };
    } catch (e) { libErr = e; console.error('Biblioteca do WhatsApp não carregou. Rode "npm install".', e.message); }
    return lib;
  }
  const authDir = id => path.join(dataDir, 'wa', id);
  const status = (id, patch) => { if (store.get('whatsapp', id)) store.update('whatsapp', id, { ...patch, statusEm: Date.now() }); };

  async function start(id) {
    if (sessions.has(id)) return;
    const B = await load();
    if (!B) return status(id, { status: 'erro', erro: 'A biblioteca do WhatsApp não está instalada no servidor. Rode npm install e reinicie.' });
    fs.mkdirSync(authDir(id), { recursive: true });
    const { state, saveCreds } = await B.useMultiFileAuthState(authDir(id));
    let version; try { if (B.fetchLatestBaileysVersion) ({ version } = await B.fetchLatestBaileysVersion()); } catch {}
    const sock = B.make({ auth: state, logger: SILENT, printQRInTerminal: false, browser: ['Draven CRM', 'Chrome', '1.0.0'], syncFullHistory: false, markOnlineOnConnect: false, ...(version ? { version } : {}) });
    const s = { sock, qr: null, stop: false, qrs: 0 };
    sessions.set(id, s);
    status(id, { status: 'iniciando', erro: null });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', u => {
      if (u.qr) { s.qr = u.qr; s.qrs++; status(id, { status: 'aguardando_qr' }); }
      if (u.connection === 'open') {
        s.qr = null;
        const numero = String(sock.user?.id || '').split(':')[0].split('@')[0];
        status(id, { status: 'conectado', numero, nomePerfil: sock.user?.name || '', conectadoEm: Date.now(), erro: null });
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sessions.delete(id);
        if (s.stop) return;
        if (code === B.DisconnectReason.loggedOut) {
          fs.rmSync(authDir(id), { recursive: true, force: true });
          status(id, { status: 'desconectado', erro: 'O celular removeu este aparelho. Gere um novo QR Code para conectar de novo.' });
        } else if (!sock.user && s.qrs >= 5) {
          status(id, { status: 'qr_expirado', erro: 'O QR Code expirou sem leitura. Clique em Gerar QR Code para tentar de novo.' });
        } else {
          status(id, { status: 'reconectando' });
          setTimeout(() => start(id).catch(e => console.error(e)), 3000);
        }
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages || []) onMessage(id, m).catch(e => console.error('Erro ao registrar mensagem:', e));
    });
  }

  function acharCliente(tel) {
    const k = telKey(tel); if (!k || k.length < 10) return null;
    return store.list('clientes').find(c => telKey(c.data.telefone) === k) || null;
  }

  async function onMessage(cid, m) {
    const jid = m.key?.remoteJid || '';
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
    const conteudo = extrair(m.message); if (!conteudo) return;
    const msgId = safeId(m.key.id); if (!msgId) return;
    const fromMe = !!m.key.fromMe;
    const alt = [m.key.remoteJidAlt, m.key.senderPn, m.key.participantAlt].find(x => String(x || '').endsWith('@s.whatsapp.net')) || '';
    const pnJid = jid.endsWith('@s.whatsapp.net') ? jid : alt;
    const tel = pnJid ? pnJid.split('@')[0].split(':')[0] : '';
    const chave = safeId(tel || jid.split('@')[0]);
    const convId = `${cid}-${chave}`;
    if (store.get(`conversas/${convId}/msgs`, msgId)) return;
    const con = store.get('whatsapp', cid) || {};
    const em = (Number(m.messageTimestamp) || 0) * 1000 || Date.now();
    const agora = Date.now();
    const conv = store.get('conversas', convId);
    let clienteId = conv?.clienteId && store.get('clientes', conv.clienteId) ? conv.clienteId : null;
    let cliente = clienteId ? store.get('clientes', clienteId) : null;
    if (!cliente && tel) { const f = acharCliente(tel); if (f) { cliente = f.data; clienteId = f.id; } }
    const nomeWA = fromMe ? '' : String(m.pushName || '').trim();
    const origemTxt = con.nome ? `WhatsApp ${con.nome}` : 'WhatsApp';

    // conversa que a equipe começou pelo celular com um número fora do CRM: vira lead só se o número estiver configurado para isso
    const semLead = !cliente && fromMe && con.leadsDaEquipe === false;
    if (semLead) { /* fica só em Conversas, com o botão "Adicionar ao funil" */ }
    else if (!cliente) {
      const g = classificar(nomeWA + ' ' + conteudo.texto);
      clienteId = rid();
      cliente = {
        nome: nomeWA || (tel ? fmtTel(tel) : 'Contato do WhatsApp'), contato: nomeWA, telefone: tel ? fmtTel(tel) : '', tipo: g.tipo, modalidades: g.interesse,
        origem: 'WhatsApp', origemDetalhe: con.nome || '', whatsConexao: cid, etapa: 'lead', responsavel: con.responsavel || null, valorEstimado: 0,
        proximaAcao: fromMe ? 'Acompanhar conversa iniciada pela equipe no WhatsApp' : 'Responder mensagem recebida no WhatsApp', dataProxima: agora,
        consentWhats: false, consentEmail: false, criadoEm: agora, atualizadoEm: agora, ultimaWhatsEm: agora, entradaWhats: true, criadoPor: null,
        historico: [{ txt: `Lead criado automaticamente pelo ${origemTxt}${fromMe ? ' (conversa iniciada pela equipe)' : ''}: "${cut(conteudo.texto, 160)}"${g.tipo !== 'Outro' ? ` · classificado como ${g.tipo}` : ''}${g.interesse ? ` · interesse: ${g.interesse}` : ''}`, em: agora, por: null }],
      };
      store.set('clientes', clienteId, cliente);
      if (ai && !fromMe && conteudo.tipo === 'texto') classificarComIA(clienteId, nomeWA, conteudo.texto).catch(() => {});
    } else {
      const patch = { atualizadoEm: agora, ultimaWhatsEm: agora };
      const novaConversa = !conv || agora - (conv.ultimaEm || 0) > 12 * 3600e3;
      if (!fromMe && novaConversa) {
        let nota = `Nova conversa pelo ${origemTxt}: "${cut(conteudo.texto, 160)}"`;
        if (cliente.etapa === 'perdido') { patch.etapa = 'contato'; nota += ' · contato retomado, voltou para Primeiro contato'; }
        if (cliente.etapa === 'ganho') { patch.proximaAcao = 'Cliente ativo chamou no WhatsApp: verificar novo pedido'; patch.dataProxima = agora; }
        else if (['lead', 'contato', 'perdido'].includes(cliente.etapa || 'lead')) { patch.proximaAcao = 'Responder mensagem recebida no WhatsApp'; patch.dataProxima = agora; }
        patch.historico = [...(cliente.historico || []), { txt: nota, em: agora, por: null }];
      }
      if (!cliente.telefone && tel) patch.telefone = fmtTel(tel);
      if (!cliente.contato && nomeWA) patch.contato = nomeWA;
      cliente = store.update('clientes', clienteId, patch);
    }

    store.set(`conversas/${convId}/msgs`, msgId, { texto: conteudo.texto, tipo: conteudo.tipo, deMim: fromMe, em, por: null });
    store.set('conversas', convId, {
      ...(conv || {}), conexaoId: cid, conexaoNome: con.nome || '', clienteId: clienteId || null, telefone: tel, jid, nome: cliente?.nome || conv?.nome || (tel ? fmtTel(tel) : 'Contato do WhatsApp'),
      ultimaMsg: cut(conteudo.texto, 140), ultimaEm: em, ultimaDeMim: fromMe, naoLidas: fromMe ? 0 : (conv?.naoLidas || 0) + 1,
      responsavel: cliente?.responsavel || con.responsavel || null, criadoEm: conv?.criadoEm || agora,
    });
  }

  async function classificarComIA(clienteId, nome, texto) {
    const resp = await ai(`Você classifica contatos que chegam pelo WhatsApp da Draven Sports, fabricante brasileira de equipamentos esportivos (luvas de boxe e muay thai, luvas de goleiro, kimonos, protetores, bandagens) que vende no atacado para academias, equipes, escolinhas e lojas, faz marca própria (produtos com o logo do cliente) e também vende no varejo.
Nome do perfil: ${nome || '(sem nome)'}
Primeira mensagem: ${texto}
Responda só com JSON, sem texto fora dele: {"tipo": um de ${JSON.stringify(TIPOS)}, "interesse": "produtos citados, curto", "potencial": número em reais estimado para um primeiro pedido ou 0 se não der para estimar, "resumo": "uma frase sobre o que o contato quer"}`, 400);
    const j = JSON.parse(resp.slice(resp.indexOf('{'), resp.lastIndexOf('}') + 1));
    const c = store.get('clientes', clienteId); if (!c) return;
    const patch = { historico: [...(c.historico || []), { txt: `Classificação automática (IA): ${cut(j.resumo || '', 200)}`, em: Date.now(), por: null }] };
    if (TIPOS.includes(j.tipo) && (c.tipo === 'Outro' || !c.tipo)) patch.tipo = j.tipo;
    if (j.interesse && !c.modalidades) patch.modalidades = cut(j.interesse, 120);
    if (Number(j.potencial) > 0 && !c.valorEstimado) patch.valorEstimado = Math.round(Number(j.potencial));
    store.update('clientes', clienteId, patch);
  }

  return {
    async boot() { for (const c of store.list('whatsapp')) if (fs.existsSync(authDir(c.id)) && c.data.status !== 'desconectado') start(c.id).catch(e => console.error(e)); },
    async create({ nome, responsavel, leadsDaEquipe }, me) {
      const n = String(nome || '').trim(); if (!n) { const e = new Error('Dê um nome para identificar este número.'); e.status = 400; e.code = 'invalid_argument'; throw e; }
      const id = 'w' + rid(10);
      store.set('whatsapp', id, { nome: n, responsavel: responsavel || null, leadsDaEquipe: leadsDaEquipe !== false, status: 'iniciando', criadoEm: Date.now(), criadoPor: me.id });
      start(id).catch(e => { console.error(e); status(id, { status: 'erro', erro: 'Não foi possível iniciar a conexão.' }); });
      return { id };
    },
    qr(id) { const s = sessions.get(id); const d = store.get('whatsapp', id); return { status: d?.status || 'inexistente', qr: s?.qr || null, erro: d?.erro || null, numero: d?.numero || null }; },
    async restart(id) { const s = sessions.get(id); if (s) { s.stop = true; try { s.sock.end?.(); } catch {} sessions.delete(id); } await start(id); },
    async logout(id) {
      const s = sessions.get(id);
      if (s) { s.stop = true; try { await s.sock.logout(); } catch {} try { s.sock.end?.(); } catch {} sessions.delete(id); }
      fs.rmSync(authDir(id), { recursive: true, force: true });
      status(id, { status: 'desconectado', erro: null, numero: null });
    },
    async remove(id) { await this.logout(id); store.del('whatsapp', id); },
    async send({ conversaId, clienteId, conexaoId, texto }, me) {
      const fail = m => { const e = new Error(m); e.status = 400; e.code = 'invalid_argument'; return e; };
      texto = String(texto || '').trim(); if (!texto) throw fail('Escreva a mensagem.');
      let conv = conversaId ? store.get('conversas', conversaId) : null, convId = conversaId;
      let jid, cid, cli;
      if (conv) { jid = conv.jid; cid = conv.conexaoId; clienteId = conv.clienteId; }
      else {
        cli = store.get('clientes', clienteId); if (!cli) throw fail('Cliente não encontrado.');
        let d = String(cli.telefone || '').replace(/\D/g, ''); if (d.length < 10) throw fail('Este cliente não tem um telefone válido.');
        if (!d.startsWith('55') || d.length <= 11) d = '55' + d;
        cid = conexaoId; jid = d + '@s.whatsapp.net';
        convId = `${cid}-${safeId(d)}`; conv = store.get('conversas', convId);
      }
      const s = sessions.get(cid); const con = store.get('whatsapp', cid);
      if (!s || con?.status !== 'conectado') throw fail('Este número de WhatsApp não está conectado agora.');
      if (!conv && s.sock.onWhatsApp) { try { const [r] = await s.sock.onWhatsApp(jid); if (r && !r.exists) throw fail('Este telefone não tem WhatsApp.'); if (r?.jid) jid = r.jid; } catch (e) { if (e.code) throw e; } }
      const r = await s.sock.sendMessage(jid, { text: texto });
      const msgId = safeId(r?.key?.id) || 'm' + rid(12); const agora = Date.now();
      store.set(`conversas/${convId}/msgs`, msgId, { texto, tipo: 'texto', deMim: true, em: agora, por: me.id });
      cli = cli || store.get('clientes', clienteId);
      store.set('conversas', convId, { ...(conv || { criadoEm: agora, naoLidas: 0 }), conexaoId: cid, conexaoNome: con.nome || '', clienteId, jid, telefone: conv?.telefone || jid.split('@')[0], nome: cli?.nome || conv?.nome || '', ultimaMsg: cut(texto, 140), ultimaEm: agora, ultimaDeMim: true, naoLidas: 0, responsavel: cli?.responsavel || con.responsavel || null });
      if (cli) store.update('clientes', clienteId, { ultimaWhatsEm: agora, atualizadoEm: agora });
      return { ok: true, conversaId: convId };
    },
    fakeIncoming({ conexaoId, tel, nome, texto, fromMe }) {
      const s = sessions.get(conexaoId); if (!s) return;
      s.sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: tel + '@s.whatsapp.net', id: 'IN' + Math.random().toString(36).slice(2, 12).toUpperCase(), fromMe: !!fromMe }, pushName: nome, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: texto } }] });
    },
  };
}

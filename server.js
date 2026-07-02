const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
const APP_PASSWORD = process.env.APP_PASSWORD || 'values2026';

const PAUTAS_KEY = 'b3:pautas';
const HISTORICO_KEY = 'b3:historico';
const SESSIONS_KEY = 'b3:sessions';

// --- UPSTASH HELPERS ---
async function upGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) { console.error('Upstash GET erro:', e.message); return null; }
}

async function upSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  try {
    const encoded = encodeURIComponent(JSON.stringify(value));
    const r = await fetch(`${UPSTASH_URL}/set/${key}/${encoded}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    return data.result === 'OK';
  } catch (e) { console.error('Upstash SET erro:', e.message); return false; }
}

// --- AUTENTICAÇÃO ---
function gerarToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function validarSessao(req) {
  const token = req.headers['x-session-token'];
  if (!token) return false;
  const sessions = await upGet(SESSIONS_KEY) || {};
  const sessao = sessions[token];
  if (!sessao) return false;
  // Sessão válida por 12 horas
  if (Date.now() - sessao.criada > 12 * 60 * 60 * 1000) {
    delete sessions[token];
    await upSet(SESSIONS_KEY, sessions);
    return false;
  }
  return true;
}

app.post('/login', async (req, res) => {
  const { senha } = req.body;
  if (senha !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  const token = gerarToken();
  const sessions = await upGet(SESSIONS_KEY) || {};
  sessions[token] = { criada: Date.now() };
  await upSet(SESSIONS_KEY, sessions);
  res.json({ token });
});

app.post('/logout', async (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) {
    const sessions = await upGet(SESSIONS_KEY) || {};
    delete sessions[token];
    await upSet(SESSIONS_KEY, sessions);
  }
  res.json({ ok: true });
});

// Middleware de autenticação para rotas protegidas
async function auth(req, res, next) {
  if (!await validarSessao(req)) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

// --- PAUTAS ---
app.get('/pautas', auth, async (req, res) => {
  res.json(await upGet(PAUTAS_KEY) || []);
});

app.post('/pautas', auth, async (req, res) => {
  const { titulo, descricao } = req.body;
  if (!titulo) return res.status(400).json({ error: 'Título obrigatório' });
  const pautas = await upGet(PAUTAS_KEY) || [];
  const nova = { id: Date.now(), titulo: titulo.toUpperCase().trim(), descricao: (descricao || '').trim(), criada: new Date().toISOString() };
  pautas.push(nova);
  await upSet(PAUTAS_KEY, pautas);
  res.json(nova);
});

app.delete('/pautas/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const pautas = (await upGet(PAUTAS_KEY) || []).filter(p => p.id !== id);
  await upSet(PAUTAS_KEY, pautas);
  res.json({ ok: true });
});

// --- HISTÓRICO ---
app.get('/historico', auth, async (req, res) => {
  const historico = await upGet(HISTORICO_KEY) || [];
  res.json(historico.slice(0, 200));
});

app.delete('/historico', auth, async (req, res) => {
  await upSet(HISTORICO_KEY, []);
  res.json({ ok: true });
});

// --- CLASSIFICAÇÃO ---
app.post('/classificar', auth, async (req, res) => {
  const { texto, veiculo, titulo_noticia } = req.body;
  if (!texto) return res.status(400).json({ error: 'Texto obrigatório' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Chave Anthropic não configurada' });

  const pautas = await upGet(PAUTAS_KEY) || [];
  const prompt = buildPrompt(texto, pautas);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    const raw = data.content?.[0]?.text || '';

    if (raw.trim().startsWith('{"aprovada"')) {
      // Salvar no histórico como desaprovada
      await salvarHistorico({ aprovada: false, titulo: titulo_noticia || texto.slice(0, 80), veiculo: veiculo || '', ts: new Date().toISOString() });
      return res.json({ aprovada: false });
    }

    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      // Salvar no histórico
      await salvarHistorico({ aprovada: true, titulo: titulo_noticia || texto.slice(0, 80), veiculo: veiculo || '', ts: new Date().toISOString(), resultado: parsed });
      return res.json({ aprovada: true, resultado: parsed });
    } catch {
      return res.json({ aprovada: true, resultado: raw });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function salvarHistorico(entrada) {
  try {
    const historico = await upGet(HISTORICO_KEY) || [];
    historico.unshift(entrada);
    // Manter só os últimos 500
    await upSet(HISTORICO_KEY, historico.slice(0, 500));
  } catch (e) { console.error('Erro ao salvar histórico:', e.message); }
}



// Servir arquivos estáticos APÓS autenticação via frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

function buildPrompt(texto, pautas) {
  const listaPautas = pautas.length > 0
    ? pautas.map(p => `- ${p.titulo}${p.descricao ? ': ' + p.descricao : ''}`).join('\n')
    : '(nenhuma pauta ativa cadastrada)';

  return `Você é um analista de monitoramento de imprensa especializado na B3 - Brasil, Bolsa, Balcão. Seu objetivo é ler uma notícia e preencher os critérios de avaliação do sistema de clipping, classificando cada matéria de acordo com o escopo de monitoramento da B3. A B3 é a principal infraestrutura do mercado financeiro brasileiro. Opera nos segmentos de renda variável, renda fixa, derivativos, leilões de infraestrutura pública, dados e analytics, tecnologia, educação financeira, ESG, tokenização e serviços financeiros.

id_9791: POSITIVA: A B3 é protagonista de avanços, conquistas, recordes, inovações, iniciativas, elogios ou falas que reforçam sua credibilidade como infraestrutura do mercado financeiro brasileiro, sendo o sujeito ativo da notícia; NEGATIVA: A B3 é o sujeito principal de falhas operacionais, litígios, processos regulatórios adversos (CADE, CVM, CARF), críticas institucionais, saída em massa de empresas listadas ou conflitos com participantes do mercado; NEUTRA: A matéria cobre fatos de mercado onde a B3 aparece como contexto, ambiente ou fonte de dados, como oscilação rotineira de índices, cobertura de empresas listadas, análises de analistas ou estatísticas sem ação protagonista da B3.

id_9821: SIM: O termo B3 ou Ibovespa aparece explicitamente no título da matéria; NÃO: Nenhum desses termos aparece no título.

id_9901: SIM: O texto contém explicitamente um dos seguintes termos em qualquer parte, mesmo como menção de passagem: B3 (referindo-se à instituição Brasil, Bolsa, Balcão), Ibovespa, B3SA3, bolsa brasileira, Brasil Bolsa Balcão; NÃO: O texto não contém nenhum desses termos. Termos como a bolsa (sem qualificador), nomes de índices como IFIX e IBrX e nomes de produtos como Tesouro Direto e Datawise NÃO contam como citação da marca neste momento.

id_9888: Identifique o subtema macro da matéria. Retorne EXCLUSIVAMENTE um dos valores abaixo, nunca retorne assuntos granulares como DUPLICATAS, LISTADOS ou ÍNDICE pois esses são preenchidos automaticamente pelo sistema.

FINANCEIRO: B3 como empresa listada, resultados, balanço trimestral, destaques operacionais, B3SA3, B3 Day, não confundir com infraestrutura de mercado.

INSTITUCIONAL: governança, estratégia, Conselho de Administração, Diretoria Estatutária, nomeações, eventos MKBR e B3 Week, falas macroeconômicas do CEO, marca e patrocínios, prêmios.

CONCORRÊNCIA: empresas concorrentes mesmo sem citar a B3. Monitorados: Núclea, Cerc, CSD BR (Edivar Queiroz), Base Exchange/ATG/Flowa/Bolsa do Rio (Claudio Pracownik), SL Tools (André Duvivier), A5X (Carlos Ferreira Filho, Karel Luketic, Nilson Monteiro, Julian Chediak, Cícero Vieira), BEE4 (Patrícia Stille), Kalshi (Luana Lopes Lara), Polymarket. NASDAQ e NYSE apenas quando IPO de empresa BRASILEIRA nessas bolsas (exportação de mercado). IPO de empresa ESTRANGEIRA que gere BDR na B3 NÃO é CONCORRÊNCIA, é MERCADO DE CAPITAIS.

IMPACTO NA SOCIEDADE: B3 Social, B3 Educação, ESG (ISE, ICO2, IDIVERSA, IGPTW, Green Bonds, Sustainability-Linked Bonds, CBIO, ESG Workspace, mercado de carbono), Diversidade e Lideranças Plurais, Leilões de infraestrutura (concessões, PPPs, privatizações, alienações) apenas quando a B3 é citada como operadora.

MARCA EMPREGADORA: programa de estágio, trainee, Manas da Tech, GPTW, carreira, atração de talentos, diversidade para dentro.

TECNOLOGIA E INOVAÇÃO: sistema PUMA, latência, data center, co-location, IA (apenas quando relacionada à infraestrutura tecnológica da B3, não IA em geral), cibersegurança, tokenização (B3RL, stablecoin, blockchain), Novos Negócios (L4 Venture Builder, BOAA). Matérias sobre IA em geral sem relação com a infraestrutura da B3 NÃO entram aqui.

MERCADO DE CAPITAIS: Empresas e Emissores (IPO, follow-on, OPA, abertura/fechamento de capital, deslistagem, Novo Mercado, Regime Fácil, B3 Way, crowdfunding, BDR de empresas estrangeiras lançados pela B3, fatos relevantes de governança e estratégia de empresas listadas como troca de executivos e reestruturações), Listados (ações, derivativos, futuros, criptoativos, ETFs, FIIs, Fiagros, BDRs, aluguel de ativos, mercados preditivos), Operações (pregão, clearing, liquidação, circuit breaker, horário estendido, HFT), Índices (Ibovespa, IBrX, IFIX, SMLL, MIDL e demais índices B3, rebalanceamento de carteira teórica é POSITIVA não NEUTRA), Securities and Financial Services (Banco B3).

CRÉDITO E RENDA FIXA: Renda Fixa (Trademate, CDB, LCI, LCA, debêntures, CRI, CRA, COE, nota comercial), Duplicatas (duplicata escritural, monitor de recebíveis). Desempate Tesouro Direto vs Renda Fixa: se o emissor for o Tesouro Nacional use INVESTIDOR/Tesouro Direto; se for instituição privada use CRÉDITO E RENDA FIXA.

ECOSSISTEMA B3: corretoras, assets, bancos de investimento apenas quando a matéria trata da relação comercial ou parceria com a B3. Se a instituição aparece como empresa independente sem citar a B3, não entra aqui.

INVESTIDOR: Pessoa Física (App B3, Área do Investidor, qualquer estatística sobre CPFs ou perfil do investidor brasileiro na bolsa mesmo sem citar o App), Tesouro Direto (Tesouro Selic, IPCA+, EducA+, RENDA+, OLITEF, TD Impacta, Tesouro Reserva).

DADOS E INTELIGÊNCIA: Dados e Analytics (Up2Data, Datawise+), Trillia (SNG, gravame, Renave, Neoway, Neurotech, DataStock, PdTech, financiamento de veículos, mercado segurador, prevenção a fraudes).

REGULATÓRIO: BSM (MRP, Mecanismo de Ressarcimento de Prejuízos), CAM (Câmara de Arbitragem do Mercado), Reguladores (CVM, Banco Central, CADE, STN apenas quando a B3 é nomeada como objeto da decisão ou quando a medida impacta diretamente produto ou serviço específico da B3). Decisões regulatórias de mercado em geral sem conexão direta com a B3 NÃO entram aqui.

ASSUNTOS DE INTERESSE: exclusivamente casos de empresas BRASILEIRAS em crise sistêmica com impacto direto no mercado financeiro LOCAL (Americanas, REAG, Master e similares). NÃO inclui análises globais de mercado, IPOs no exterior de empresas estrangeiras, artigos de opinião sobre tendências internacionais ou empresas sem presença no mercado financeiro brasileiro.

id_9902: Este campo é OBRIGATÓRIO e NUNCA retorna null. É completamente independente do campo id_9793. Retorne EXATAMENTE um dos valores abaixo em CAIXA ALTA.

B3 S.A: B3 como empresa listada, balanços, resultados, destaques operacionais e B3 Day.
INSTITUCIONAL: governança, estratégia, Conselho de Administração, Diretoria Estatutária, nomeações e falas macroeconômicas do CEO da B3.
MARCA E PATROCÍNIOS: patrocínios culturais, esportivos e institucionais e reposicionamento de marca da B3.
CONCORRÊNCIA: empresas concorrentes monitoradas mesmo sem citar a B3.
B3 SOCIAL: filantropia, doações, incentivos fiscais, apoio à educação pública, braço social da B3.
B3 EDUCAÇÃO: educação financeira, programas, cursos, MUB3, Museu da Bolsa do Brasil.
ESG: produtos, iniciativas e títulos sustentáveis da B3 (ISE, ICO2, Green Bonds, CBIO, mercado de carbono, ESG Workspace).
DIVERSIDADE: diversidade, equidade, inclusão, programa Lideranças Plurais.
LEILÕES: B3 operando leilões de infraestrutura, concessões, PPPs, privatizações, apenas quando B3 é citada como operadora.
MARCA EMPREGADORA: estágio, trainee, Manas da Tech, GPTW, carreira na B3.
TECNOLOGIA E INOVAÇÃO: sistema PUMA, data centers, co-location, latência, IA da infraestrutura B3, tokenização, L4 Venture Builder, BOAA.
INSTITUCIONAL - EVENTOS: MKBR, B3 Week.
PRÊMIOS: certificações, prêmios e reconhecimentos à B3.
EMPRESAS E EMISSORES: IPO, follow-on, OPA, abertura/fechamento de capital, deslistagem, Novo Mercado, Regime Fácil, B3 Way, crowdfunding, BDR de empresa estrangeira lançado pela B3, fatos de governança de empresas listadas (troca de executivos, fusões, reestruturações).
LISTADOS: ações, derivativos, futuros, criptoativos, ETFs, FIIs, Fiagros, BDRs, aluguel de ações, mercados preditivos, desempenho de ações de empresas listadas.
OPERAÇÕES: pregão, clearing, liquidação, circuit breaker, horário estendido, HFT, PTG.
ÍNDICE: índices da B3, ETFs indexados, fechamento de mercado com variação do Ibovespa, rebalanceamento de carteira teórica.
SECURITIES AND FINANCIAL SERVICES: Banco B3, custódia, compensação, serviços financeiros para institucionais.
RENDA FIXA: Trademate, CDB, LCI, LCA, debêntures, CRI, CRA, nota comercial, dívida corporativa.
DUPLICATAS: duplicata escritural, monitor de recebíveis.
CLIENTES: corretoras, assets, bancos como clientes da B3, apenas quando trata da relação comercial com a B3.
PESSOA FÍSICA: investidor individual, App B3, Área do Investidor, CPFs na bolsa, estatísticas de investidor pessoa física.
TESOURO DIRETO: Tesouro Selic, IPCA+, EducA+, RENDA+, OLITEF, TD Impacta, Tesouro Reserva.
DADOS E ANALYTICS: Up2Data, Datawise+, produtos de dados da B3.
TRILLIA: SNG, gravame, Renave, Neoway, financiamento de veículos, mercado segurador, prevenção a fraudes.
BSM: BSM, MRP, Mecanismo de Ressarcimento de Prejuízos, autorregulação B3.
CAM: Câmara de Arbitragem do Mercado, processos arbitrais.
REGULADORES: CVM, Banco Central, CADE, STN quando associados diretamente à B3.
ASSUNTOS DE INTERESSE: casos de empresas brasileiras em crise sistêmica com impacto no mercado financeiro local (Americanas, REAG, Master e similares).

id_9793: REGRAS ABSOLUTAS para este campo: (1) Só preencha se a matéria tratar EXATAMENTE do mesmo assunto de uma pauta cadastrada abaixo. (2) Se não houver nenhuma pauta cadastrada, retorne SEMPRE null. (3) Se houver pautas cadastradas mas o assunto da matéria for diferente, retorne SEMPRE null. (4) É TERMINANTEMENTE PROIBIDO sugerir, criar ou inventar pautas que não estejam na lista abaixo. (5) Quando retornar uma pauta, use o nome exato em CAIXA ALTA.

PAUTAS ATIVAS:
${listaPautas}

id_9897: Identifique se algum nome da lista abaixo é citado na matéria com fala, cargo ou menção direta. Se nenhum for citado retorne null. Use correspondência aproximada: primeiro nome, sobrenome isolado ou variação sem acento contam. Retorne sempre em CAIXA ALTA. Múltiplos nomes separados por vírgula. Citação por cargo sem nomear a pessoa NÃO conta.

ADRIANA BRAGHETTA, ALINE QUINTANILHA, ANA BUCHAIM, ANA CAROLINA FLÓRIO, ANA LÚCIA PEREIRA, ANDRÉ BALISTRELI, ANDRÉ DEMARCO, ANDRÉ MILANEZ, ANGÉLICA TOZETTI, BERNARDO MELLO, BIANCA MARIA, BRUNA DE CARO, BRUNA MARQUES, BRUNO SALDANHA, CAMILA FARIA, CHRISTIAN EGAN, CHRISTIANNE BARIQUELLI, CLAUDIA BORTOLETTO, CLAUDIA HOSHIBA, CLAUDIA PIMENTEL, CRISTIANO ARAUJO, DANIEL DEMATTIO, DANIEL TAKATOHI, DAVI DOS SANTOS DE FREITAS, DIEGO FERNANDES ARAUJO, DUILIO ALVES PAIVA, EDUARDO MARQUES, ELAINE TRAVIZZANUTTO, EMÍLIO QUEIROGA, ERIKA FUGA, ERIKA KURAUCHI, FABIANA PRIANTI, FELIPE GONÇALVES, FELIPE LETTIERE, FELIPE PAIVA, FERNANDO BIANCHINI, FERNANDO TAVARES DE CAMPOS, FLAVIA MOUTA, FRANCISCO SATIRO DE SOUZA JÚNIOR, GILSON FINKELSZTAIN, GUILLHERME PEIXOTO, GUSTAVO ORESTE, GUSTAVO PERES DE CARVALHO, HENRIQUE FERNANDES REIS DAS CHAGAS, HUMBERTO COSTA, HÊNIO SCHEIDT, ITA NUNES DA SILVA, JANAINA VILELLA, JOCHEN MIELKE DE LIMA, JOÃO RICARDO DE MORAIS MORBIM, JUAN WIEGAND, JÉSSICA ROSANI, LEONARDO BETANHO, LEONARDO RESENDE, LOURDES SILVA, LUCIANA COSTA, LUIZ MASAGÃO, LUIZA SANGALLI, MANUELA ALVES, MARCOS COCITE, MARCOS SKISTYMAS, MARCOS VANDERLEI, MARIA LUIZA LIMERES, MARINA NAIME, MARIO PALHARES, MAURICIO TERAMOTO, MÁRCIO PRADO, MÔNICA SALLES LANNA, NATALIA CHIARONI SILVEIRA, NATHALIA FARIAS, PEDRO MEDUNA, PEDRO ZANGRANDI BUSTAMANTE, RAFAEL TARIFA, RAFAEL TSOPANOGLOU, RAFAELA VESTERMAN, RAPHAEL GIOVANINI, RENATA CAFFARO, RENATO MUNHOZ, RICARDO CAMPANHÃ, ROBERTA FORTUNATO, RODRIGO AMÂNCIO, RODRIGO ANTÔNIO, RODRIGO BARCIA, RODRIGO GONÇALES, RODRIGO NARDONI, ROGÉRIO SANTANA, THAIS MAHARAJ, THALITA FORNE, THIAGO GASPAR, THIAGO SUZANO, TIAGO WIGMAN, VIRGINIA NICOLAU, VIVIANE BASSO.

Traga como resposta somente o JSON sem markdown com os campos id_9791, id_9821, id_9901, id_9888, id_9902, id_9793, id_9897, explicacao-id_9791, explicacao-id_9821, explicacao-id_9901, explicacao-id_9888, explicacao-id_9902, explicacao-id_9793, explicacao-id_9897, cada explicação em até 50 palavras. No campo explicacao-id_9791 inclua qual a relação com a B3 e adicione ao final | Alerta: [observação] se houver dupla leitura estratégica relevante. Adicione ao final manter_avaliacao com valor true.

Retorne {"aprovada": false} SOMENTE se a matéria não se enquadrar em NENHUMA das seguintes condições: 1. Cita B3, Ibovespa, bolsa brasileira, B3SA3 ou Brasil Bolsa Balcão; 2. Trata de empresa listada na B3; 3. Trata de concorrente monitorado; 4. Trata de produto ou serviço da B3; 5. Trata de índice, pregão, fluxo de capital ou fechamento de mercado brasileiro; 6. Trata de caso específico do mercado financeiro BRASILEIRO que a B3 acompanha estrategicamente (empresas brasileiras em crise sistêmica local); 7. Trata de tema regulatório ou de política monetária com impacto DIRETO E IMEDIATO no mercado financeiro brasileiro. Análises globais, IPOs de empresas estrangeiras sem BDR na B3 e tendências internacionais sem conexão com o mercado brasileiro devem ser desaprovadas.

MATÉRIA:
${texto}`;
}

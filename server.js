const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

app.post('/classificar', async (req, res) => {
  const { texto } = req.body;
  if (!texto) return res.status(400).json({ error: 'Texto obrigatório' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Chave Anthropic não configurada no servidor' });

  const prompt = buildPrompt(texto);

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
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    const txt = data.content?.[0]?.text || '';
    res.json({ resultado: txt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/buscar-noticia', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID da notícia obrigatório' });

  const AKAII_KEY = process.env.AKAII_API_KEY;
  if (!AKAII_KEY) return res.status(500).json({ error: 'Chave Akaii não configurada no servidor' });

  try {
    const url = `http://noticia.valuescomunicacao.com.br/b3/api/noticia/?key=${AKAII_KEY}&id=${id}&formato=json`;
    const r = await fetch(url);
    const buffer = await r.arrayBuffer();
    const decoder = new TextDecoder('iso-8859-1');
    const rawText = decoder.decode(buffer);

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('Resposta não-JSON da API Akaii:', rawText.slice(0, 500));
      return res.status(502).json({
        error: 'A API do Akaii retornou uma resposta inválida (não-JSON). Verifique a chave AKAII_API_KEY ou se o ID existe.',
        raw_preview: rawText.slice(0, 300)
      });
    }

    const lista = Array.isArray(parsed) ? parsed : (parsed.data || parsed.noticias || [parsed]);
    const item = Array.isArray(lista) ? lista[0] : lista;

    if (!item || !item.texto) {
      return res.status(404).json({
        error: 'Notícia não encontrada ou sem texto disponível',
        debug_estrutura: JSON.stringify(parsed).slice(0, 1000)
      });
    }
    res.json({
      titulo: item.titulo || '',
      texto: (item.texto || '').replace(/<br\s*\/?>/gi, '\n').replace(/\n{3,}/g, '\n\n').trim(),
      veiculo: item.veiculo || '',
      data: item.data || '',
      categoria_atual: item.categoria || ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/gravar-categoria', async (req, res) => {
  const { id, id_akaii } = req.body;
  if (!id || !id_akaii) return res.status(400).json({ error: 'ID da notícia e ID da categoria obrigatórios' });

  try {
    const url = `http://noticia.valuescomunicacao.com.br/b3/site/m020/noticia_exe.asp?op=SALVAR_CATEGORIA&cd_noticia=${id}&lista_categoria=${id_akaii}`;
    const r = await fetch(url);
    const txt = await r.text();
    res.json({ ok: true, resposta: txt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

function buildPrompt(texto) {
  return `Você é um analista de clipping especializado em monitoramento de imprensa da B3 (Brasil, Bolsa, Balcão). Leia a matéria abaixo e classifique dentro da arquitetura de temas da B3.

PORTA-VOZES OFICIAIS DA B3:
Adriana Braghetta, Aline Quintanilha, Ana Buchaim, Ana Carolina Flório, Ana Lúcia Pereira, André Balistreli, André Demarco, André Milanez, Angélica Tozetti, Bernardo Mello, Bianca Maria, Bruna De Caro, Bruna Marques, Bruno Saldanha, Camila Faria, Christian Egan, Christianne Bariquelli, Claudia Bortoletto, Claudia Hoshiba, Claudia Pimentel, Cristiano Araujo, Daniel Demattio, Daniel Takatohi, Davi dos Santos de Freitas, Diego Fernandes Araujo, Duilio Alves Paiva, Eduardo Marques, Elaine Travizzanutto, Emílio Queiroga, Erika Fuga, Erika Kurauchi, Fabiana Prianti, Felipe Gonçalves, Felipe Lettiere, Felipe Paiva, Fernando Bianchini, Fernando Tavares de Campos, Flavia Mouta, Francisco Satiro de Souza Júnior, Gilson Finkelsztain, Guillherme Peixoto, Gustavo Oreste, Gustavo Peres de Carvalho, Henrique Fernandes Reis Das Chagas, Humberto Costa, Hênio Scheidt, Ita Nunes da Silva, Janaina Vilella, Jochen Mielke de Lima, João Ricardo de Morais Morbim, Juan Wiegand, Jéssica Rosani, Leonardo Betanho, Leonardo Resende, Lourdes Silva, Luciana Costa, Luiz Masagão, Luiza Sangalli, Manuela Alves, Marcos Cocite, Marcos Skistymas, Marcos Vanderlei, Maria Luiza Limeres, Marina Naime, Mario Palhares, Mauricio Teramoto, Márcio Prado, Mônica Salles Lanna, Natalia Chiaroni Silveira, Nathalia Farias, Pedro Meduna, Pedro Zangrandi Bustamante, Rafael Tarifa, Rafael Tsopanoglou, Rafaela Vesterman, Raphael Giovanini, Renata Caffaro, Renato Munhoz, Ricardo Campanhã, Roberta Fortunato, Rodrigo Amâncio, Rodrigo Antônio, Rodrigo Barcia, Rodrigo Gonçales, Rodrigo Nardoni, Rogério Santana, Thais Maharaj, Thalita Forne, Thiago Gaspar, Thiago Suzano, Tiago Wigman, Virginia Nicolau, Viviane Basso

TEMAS E GATILHOS:
1 FINANCEIRO | B3 S.A. | resultados, balanço trimestral, destaques operacionais, B3SA3, B3 Day | André Milanez, Fernando Tavares de Campos
2 INSTITUCIONAL | Liderança B3 (CEO, Conselho, diretoria estatutária) / Marca e Patrocínios / Eventos (MKBR, B3 WEEK) / Prêmios | André Milanez, Christian Egan, Claudia Pimentel, Fernando Tavares de Campos, Gilson Finkelsztain, Luiz Masagão, Márcio Prado, Mario Palhares, Rodrigo Antônio, Rodrigo Gonçales, Rodrigo Nardoni, Viviane Basso
3 CONCORRÊNCIA | Núclea, Cerc, CSD BR, Edivar Queiroz, Base Exchange, ATG, Flowa, Bolsa do Rio, Fundo Mubadala, Claudio Pracownik, SL Tools, André Duvivier, A5X, Carlos Ferreira Filho, Karel Luketic, Nilson Monteiro, Julian Chediak, Cícero Vieira, BEE4, Patrícia Stille, Kalshi, Luana Lopes Lara, Polymarket, NASDAQ e NYSE (só quando IPO de empresa brasileira)
4 IMPACTO | B3 Social (Fabiana Prianti, Ana Buchaim) / B3 Educação: Educação Financeira, MUB3, Museu da Bolsa do Brasil (Marina Naime, Bruna De Caro, Maria Luiza Limeres, Lourdes Silva) / ESG: SLB, Green Bonds, CBIO, ISE, ICO2, IDIVERSA, IGPTW, mercado de carbono, títulos verdes, Sustainability-Linked Bond, ESG Workspace, B3 Ações Verdes (Janaina Vilella, Virginia Nicolau, Jéssica Rosani, Leonardo Betanho, Natalia Chiaroni Silveira) / Diversidade: Diversidade, Lideranças Plurais (Ana Buchaim, Flavia Mouta, Renata Caffaro, Manuela Alves, Ana Carolina Flório) / Leilões: certame, licitação, privatização, PPP, concessão, alienação, leilão (Guillherme Peixoto, Mônica Salles Lanna, Rogério Santana)
5 MARCA EMPREGADORA | programa de estágio, Manas da Tech, GPTW, diversidade para dentro | Ana Buchaim, Renata Caffaro, Ana Carolina Flório, Nathalia Farias, Manuela Alves
6 TECNOLOGIA E INOVAÇÃO | Core Business: latência, data center, Puma, IA (infraestrutura B3), co-location (Thiago Suzano, Cristiano Araujo, Elaine Travizzanutto, Jochen Mielke de Lima, Ita Nunes da Silva, Erika Kurauchi, Luiza Sangalli, Claudia Hoshiba) / Tokenização: B3RL, tokenização, stablecoin (Felipe Gonçalves, Humberto Costa, Eduardo Marques) / Novos Negócios: L4 Venture Builder, BOAA (Pedro Meduna, Tiago Wigman, Claudia Hoshiba)
7 MERCADO DE CAPITAIS | Empresas e Emissores: IPO, follow-on, segmento de listagem, Regime Fácil, Novo Mercado, OPA, fechamento de capital, abertura de capital, deslistagem, oferta pública inicial, re-IPO, crowdfunding, B3 Way (Viviane Basso, Flavia Mouta, Leonardo Resende, Raphael Giovanini, Felipe Lettiere, Rafaela Vesterman, Ana Lúcia Pereira) / Listados: derivativos, cash equities, juros e moedas, ETFs, FII, Fiagro, ações, BDR, aluguel de ações, empréstimo de ativos, opções de ações, opções de Ibovespa, BTC, formador de mercado, mini futuro de dólar, mini futuro de Ibovespa, futuro de dólar, futuro de Ibovespa, futuro de soja, futuro de milho, futuro de boi, futuro de Bitcoin, futuro de Ethereum, futuro de Solana, contratos futuros, futuro de ouro, mercados preditivos (Luiz Masagão, Marcos Skistymas, Thalita Forne, Bianca Maria, Felipe Gonçalves, Pedro Zangrandi Bustamante, Henrique Fernandes Reis Das Chagas, Renato Munhoz, Camila Faria, Gustavo Oreste, Rafael Tsopanoglou) / Operações: negociação, HFT, PTG, horário de funcionamento, horário estendido, clearing, pós-negociação, liquidação, depositária, circuit breaker, limite de negociação, pregão, leilão de negociação, grandes blocos, RLP (Thais Maharaj, Marcos Cocite, Daniel Demattio, Mario Palhares, Emílio Queiroga, Rafael Tarifa) / Índices: Ibovespa, IBOV, Iagro, IBRX100, IFIX, índices on demand, ICBIO, IBRX 50, IBRA, SMLL, MIDL, IDIV, IGC, IMOB, IFNC, ISE, ICO2 (Hênio Scheidt, Marcos Skistymas, Luiz Masagão, Davi dos Santos de Freitas) / Securities and Financial Services: Banco B3 (Gustavo Peres de Carvalho, Ricardo Campanhã, João Ricardo de Morais Morbim)
8 CRÉDITO E RENDA FIXA | Renda Fixa: renda fixa, Trademate, captação bancária, CDB, RDB, LCI, LCA, LIG, LCD, LF, dívida corporativa, debêntures, CRI, CRA, recebíveis, COE, CPR, nota comercial (Claudia Bortoletto, Leonardo Betanho, Fernando Bianchini, Bernardo Mello, Aline Quintanilha) / Duplicatas: duplicata escritural, monitor de recebíveis (Humberto Costa, Roberta Fortunato, Bruna Marques)
9 ECOSSISTEMA B3 | XP, BTG, Valor Econômico, Folha de SP, Estado de SP, Globo, Infomoney — apenas quando associados à relação comercial ou ecossistema da B3
10 INVESTIDOR | Pessoa Física: APP B3, Área do Investidor, BOOK PF (Felipe Paiva, Christianne Bariquelli) / Tesouro Direto: Tesouro Selic, Tesouro IPCA, EducA+, RENDA+, OLITEF, TD Impacta, Tesouro Reserva (Felipe Paiva, Christianne Bariquelli)
11 DADOS E INTELIGÊNCIA | Dados e Analytics: produtos B3, Up2Data, Datawise (Diego Fernandes Araujo, Mario Palhares, Duilio Alves Paiva, Juan Wiegand) / Trillia: PdTech, Neoway, Neurotech, DataStock, UIF, financiamento de veículos, gravame, Renave, SNG, Auto Summit B3, Fenauto, Fenabrave, SNV, mercado segurador, crédito e recuperação, compliance, prevenção a fraudes, audiências digitais, CDV, Digital Audiences, Open Care, AutoScore de Sinistralidade, Beholder, MCP Loss (Thiago Gaspar, Daniel Takatohi, Rodrigo Amâncio, Bruno Saldanha, Angélica Tozetti, Rodrigo Barcia, André Balistreli, Erika Fuga, Marcos Vanderlei, Mauricio Teramoto)
12 REGULATÓRIO | BSM: BSM, MRP, Mecanismo de Ressarcimento de Prejuízos, FGC da bolsa (André Demarco) / CAM: Câmara de Arbitragem do Mercado, CAM (Adriana Braghetta, Luciana Costa, Francisco Satiro de Souza Júnior) / Reguladores: CVM, Banco Central, CADE, STN — apenas quando associados à B3

REGRAS DE CLASSIFICAÇÃO:
1. Classifique pelo assunto CENTRAL, não periférico
2. Apenas 1 Tema e 1 Subtema
3. Se a B3 aparecer só como pano de fundo, classifique pelo tema principal
4. Se identificar executivo da B3 não listado mas com cargo da B3, sinalize
5. Se a matéria tiver dupla leitura estratégica relevante, sinalize no ALERTA ESTRATÉGICO

REGRAS PARA O CAMPO ASSUNTO:
- Escreva uma frase curta em CAIXA ALTA resumindo o fato concreto da matéria, no estilo usado pelo Akaii
- Exemplos reais: "LANÇAMENTO DE ÍNDICE ON DEMAND", "OSCILAÇÃO DO IFIX", "LANÇAMENTO DE CONTRATOS PREDITIVOS DE IPCA E PIB"
- Deve ser objetivo, sem opinião, capturando o fato principal em até 8 palavras

REGRAS PARA O CAMPO AVALIAÇÃO QUALITATIVA INSTITUCIONAL:
- POSITIVA: a matéria favorece a imagem institucional da B3 (inovação, crescimento, liderança, expansão, reconhecimento)
- NEUTRA: a matéria menciona a B3 de forma factual/informativa sem juízo de valor claro (cotações, dados de mercado, menções colaterais)
- NEGATIVA: a matéria associa a B3 a riscos, falhas, críticas, perdas, processos, concorrência avançando sobre ela, ou contextos desfavoráveis
- Justifique a avaliação em 1 frase

REGRAS PARA O CAMPO SUGESTÃO DE PORTA-VOZ — LEIA COM ATENÇÃO:
- PRIMEIRO passo obrigatório: verifique se algum nome da lista de porta-vozes oficiais aparece EXPLICITAMENTE no texto da matéria, citado com fala, cargo, ou menção direta
- Se SIM, um porta-voz foi citado → responda exatamente: "CITADO NA MATÉRIA: [nome encontrado]"
- Se NÃO, nenhum porta-voz foi citado → responda exatamente: "NÃO CITADO NENHUM PORTA-VOZ NA MATÉRIA" como primeira linha, e só then avalie se vale anotar uma sugestão
- É PROIBIDO sugerir um nome apenas porque ele está mapeado no tema ou subtema da arquitetura. O mapeamento de porta-vozes por tema serve para você ENTENDER a estrutura da B3, não para preencher esse campo automaticamente
- Uma sugestão de nome só pode aparecer DEPOIS da linha "NÃO CITADO NENHUM PORTA-VOZ NA MATÉRIA", e apenas se a B3 for protagonista central do fato (não apenas mencionada) e o veículo claramente não buscou nenhuma fala institucional sobre um fato relevante
- Para a grande maioria das matérias (cotações, dados de mercado, menções colaterais, fechamento de pregão), a resposta correta é apenas "NÃO CITADO NENHUM PORTA-VOZ NA MATÉRIA" sem sugestão adicional

FORMATO DE SAÍDA (exato, sem texto adicional):
TEMA: [número e nome]
SUBTEMA: [nome do subtema]
ASSUNTO: [frase curta em caixa alta resumindo o fato]
GATILHO IDENTIFICADO: [termo ou nome encontrado]
JUSTIFICATIVA: [1-2 frases explicando a classificação do tema]
AVALIAÇÃO QUALITATIVA: [POSITIVA, NEUTRA ou NEGATIVA]
JUSTIFICATIVA DA AVALIAÇÃO: [1 frase explicando a avaliação qualitativa]
SUGESTÃO DE PORTA-VOZ: [nome do porta-voz mais indicado, com 1 frase de justificativa]
PORTA-VOZ NÃO MAPEADO: [nome e cargo de executivo citado na matéria que não está na lista oficial, ou "Nenhum"]
ALERTA ESTRATÉGICO: [observação de dupla leitura ou cruzamento com outro tema, ou "Nenhum"]

MATÉRIA:
${texto}`;
}

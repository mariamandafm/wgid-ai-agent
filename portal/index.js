require('dotenv').config();

const express = require('express');
const session = require('express-session');
const axios = require('axios');

const {
  KEYCLOAK_URL,
  // URL usada para chamadas servidor-a-servidor (token endpoint). Em Docker
  // Compose, "localhost" dentro do container do portal não alcança o
  // container do Keycloak — use o hostname do serviço (ex: http://keycloak:8080).
  // Fora do Docker, pode ficar igual a KEYCLOAK_URL.
  KEYCLOAK_INTERNAL_URL = KEYCLOAK_URL,
  REALM,
  PORTAL_CLIENT_ID,
  PORTAL_CLIENT_SECRET,
  AGENT_CLIENT_ID,
  AGENT_CLIENT_SECRET,
  SESSION_SECRET,
  AGENT_INTERNAL_URL = 'http://agent:4111',
  PUSH_SECRET = '',
  PORT = 3000,
} = process.env;

const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TOKEN_ENDPOINT = `${KEYCLOAK_INTERNAL_URL}/realms/${REALM}/protocol/openid-connect/token`;
const AUTH_ENDPOINT = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/auth`;

// Registro de agentes conhecidos: apenas ID e URL interna.
// Nome, descrição e scopes são descobertos via GET /agent-info de cada agente.
const AGENTS = {
  'wgid-agent-v1': {
    id: 'wgid-agent-v1',
    internalUrl: AGENT_INTERNAL_URL,
  },
};

async function fetchAgentInfo(agentId) {
  const agent = AGENTS[agentId];
  if (!agent) return null;
  const { data } = await axios.get(`${agent.internalUrl}/agent-info`);
  return data;
}

function decodeJwt(token) {
  const [, payloadB64] = token.split('.');
  const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
  return JSON.parse(payloadJson);
}

const app = express();

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

app.get('/', async (req, res) => {
  const agents = await Promise.all(
    Object.keys(AGENTS).map(id => fetchAgentInfo(id).catch(() => null))
  ).then(list => list.filter(Boolean));
  res.render('index', { agents });
});

app.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: PORTAL_CLIENT_ID,
    response_type: 'code',
    scope: 'openid profile email',
    redirect_uri: REDIRECT_URI,
  });
  res.redirect(`${AUTH_ENDPOINT}?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Código de autorização ausente.');
  }

  try {
    const { data } = await axios.post(
      TOKEN_ENDPOINT,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: PORTAL_CLIENT_ID,
        client_secret: PORTAL_CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    req.session.user_token = data.access_token;
    const agentId = req.session.pendingAgentId ?? 'wgid-agent-v1';
    delete req.session.pendingAgentId;
    res.redirect(`/consent/${agentId}`);
  } catch (err) {
    console.error('Erro ao trocar código por token:', err.response?.data || err.message);
    res.status(500).send('Falha ao autenticar com o Keycloak.');
  }
});

app.get('/consent/:agentId', async (req, res) => {
  const { agentId } = req.params;
  if (!AGENTS[agentId]) {
    return res.status(404).send('Agente não encontrado.');
  }
  if (!req.session.user_token) {
    req.session.pendingAgentId = agentId;
    return res.redirect('/login');
  }

  try {
    const agentInfo = await fetchAgentInfo(agentId);
    res.render('consent', { agent: agentInfo, validityDays: 30 });
  } catch (err) {
    console.error('Erro ao buscar informações do agente:', err.message);
    res.status(502).send('Não foi possível contactar o agente. Tente novamente.');
  }
});

app.post('/authorize', async (req, res) => {
  if (!req.session.user_token) {
    return res.redirect('/login');
  }

  const { agentId } = req.body;
  if (!AGENTS[agentId]) {
    return res.status(404).send('Agente não encontrado.');
  }

  try {
    const agentInfo = await fetchAgentInfo(agentId);
    const validScopes = agentInfo.requestedScopes.map(s => s.name);
    const selected = [].concat(req.body.scopes || []).filter(s => validScopes.includes(s));

    if (selected.length === 0) {
      return res.status(400).send('Selecione ao menos um escopo para delegar.');
    }

    // 1. Obtém o token do agente (ator) via client_credentials.
    const agentTokenResponse = await axios.post(
      TOKEN_ENDPOINT,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: AGENT_CLIENT_ID,
        client_secret: AGENT_CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const actorToken = agentTokenResponse.data.access_token;

    // 2. Token Exchange (RFC 8693): troca o token da pesquisadora (subject)
    //    pelo token delegado, usando o token do agente como actor.
    const exchangeResponse = await axios.post(
      TOKEN_ENDPOINT,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: req.session.user_token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        actor_token: actorToken,
        actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        client_id: AGENT_CLIENT_ID,
        client_secret: AGENT_CLIENT_SECRET,
        scope: selected.join(' '),
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const delegatedToken = exchangeResponse.data.access_token;
    req.session.delegated_token = delegatedToken;
    req.session.delegated_agent_id = agentId;

    try {
      await axios.post(
        `${AGENTS[agentId].internalUrl}/token`,
        { token: delegatedToken },
        { headers: { 'x-push-secret': PUSH_SECRET } }
      );
    } catch (pushErr) {
      console.warn('Aviso: não foi possível entregar token ao agente:', pushErr.message);
    }

    const payload = decodeJwt(delegatedToken);
    // NOTA: o Keycloak 26.2 ainda não implementa "delegation mode" do
    // RFC 8693 — o token retornado NÃO contém o claim `act` (actor),
    // que identificaria o agente como atuando em nome do subject.
    // Quando o Keycloak suportar isso, o claim apareceria aqui em
    // `payload.act` (ex: { act: { sub: 'wgid-agent-v1' } }).
    res.render('success', {
      agent: agentInfo,
      payload,
      token: delegatedToken,
    });
  } catch (err) {
    console.error('Erro no Token Exchange:', err.response?.data || err.message);
    res.status(500).send('Falha ao executar o Token Exchange (RFC 8693).');
  }
});

app.get('/delegations', async (req, res) => {
  if (!req.session.delegated_token) {
    return res.render('delegations', { delegation: null });
  }

  const payload = decodeJwt(req.session.delegated_token);
  const agentId = req.session.delegated_agent_id ?? 'wgid-agent-v1';
  const agentInfo = await fetchAgentInfo(agentId).catch(() => ({ name: agentId }));

  res.render('delegations', {
    delegation: {
      agent: agentInfo,
      scope: payload.scope,
      payload,
    },
  });
});

app.post('/revoke', (req, res) => {
  delete req.session.delegated_token;
  delete req.session.delegated_agent_id;
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Portal de delegação rodando em http://localhost:${PORT}`);
});

import express from 'express';
import dotenv from 'dotenv';

import { verifyToken, requireScope } from './auth.js';
import { readAuditLog } from './audit.js';
import { buscarSequencias, submeterJob, exportarDados } from './tools.js';

dotenv.config();

const KEYCLOAK_URL = process.env.KEYCLOAK_URL;
const REALM = process.env.REALM;
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());

// Rotas sem autenticação (apenas para fins de demonstração da PoC).
app.get('/health', (req, res) => {
  res.json({ status: 'ok', keycloak: KEYCLOAK_URL, realm: REALM });
});

app.get('/audit', async (req, res) => {
  const entries = await readAuditLog(20);
  res.json(entries);
});

// Ferramentas protegidas por token OAuth 2.0 delegado.
// Nomes de rota compatíveis com as chamadas feitas pelo agente Mastra em
// agent/src/mastra/tools/wgid-tool.ts (recurso /api/datasets/:id/... e
// /api/jobs/...).
app.get(
  '/api/datasets/:dataset_id/sequences',
  verifyToken,
  requireScope('genomica:read'),
  buscarSequencias
);

app.post('/api/jobs/submit', verifyToken, requireScope('hpc:submit'), submeterJob);

// /api/datasets/:dataset_id/export segue o mesmo modelo das rotas acima,
// ainda sem uma tool correspondente no agente. Como o scope genomica:export
// nunca é concedido no consentimento desta PoC, a checagem de escopo nega
// genuinamente a chamada (403), e o próprio requireScope grava o audit event
// (status=Denied).
app.get(
  '/api/datasets/:dataset_id/export',
  verifyToken,
  requireScope('genomica:export', {
    action: 'exportar-dados',
    resource: (req) => req.params?.dataset_id,
  }),
  exportarDados
);

app.listen(PORT, () => {
  console.log(`API escutando na porta ${PORT}`);
  console.log(`Keycloak: ${KEYCLOAK_URL} | Realm: ${REALM}`);
});

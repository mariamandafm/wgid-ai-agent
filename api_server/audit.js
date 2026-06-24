import { appendFile, readFile } from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();

const AUDIT_LOG_FILE = process.env.AUDIT_LOG_FILE || './audit.log';

/**
 * Grava um evento de auditoria como uma linha JSON no AUDIT_LOG_FILE.
 *
 * @param {object} params
 * @param {object} params.auth - req.auth populado pelo middleware verifyToken
 * @param {string} params.action - nome da ferramenta chamada
 * @param {string} params.resource - identificador do recurso acessado
 * @param {string} params.scopeUsed - scope verificado para a ação
 * @param {"Success"|"Denied"} params.status
 */
export async function writeAuditLog({ auth, action, resource, scopeUsed, status }) {
  // TODO(act-claim): quando o `act` claim estiver disponível no Keycloak,
  // o campo `agent` deve ser lido de `auth.raw.act.sub` em vez de `auth.agent_id`
  // (que hoje vem de `azp`, o workaround documentado em auth.js).
  const entry = {
    timestamp: new Date().toISOString(),
    user: auth?.email ?? auth?.username ?? null,
    agent: auth?.agent_id ?? null,
    is_delegated: Boolean(auth?.is_delegated),
    action,
    resource,
    scope_used: scopeUsed,
    status,
    // Registra explicitamente a limitação atual do Keycloak 26.2 (V2 Standard
    // Token Exchange não emite `act`), para comparação após atualização.
    act_claim_present: Boolean(auth?.raw?.act?.sub),
  };

  await appendFile(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

/**
 * Lê as últimas `limit` entradas do audit log.
 */
export async function readAuditLog(limit = 20) {
  let content;
  try {
    content = await readFile(AUDIT_LOG_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const lines = content.split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line));
}

// =============================================================================
// LIMITAÇÃO CONHECIDA — Keycloak 26.2 Standard Token Exchange V2 e o `act` claim
// =============================================================================
//
// O RFC 8693 (OAuth 2.0 Token Exchange) define o "delegation mode": quando um
// agente troca um token em nome de um usuário, o token resultante deveria
// conter um claim `act` (actor) identificando quem está agindo:
//
//   {
//     "sub": "<uuid-do-usuario>",
//     "act": { "sub": "<client-id-do-agente>" }
//   }
//
// Na documentação oficial do Keycloak (tabela de comparação V1 Token Exchange
// vs. V2 Standard Token Exchange — "Token Exchange" / "Internal-to-internal
// token exchange"), o `act` claim do delegation mode está marcado como
// "Not supported yet" na V2 (Keycloak 26.x). Ou seja: o Standard Token
// Exchange V2 atual do Keycloak 26.2 NÃO emite o claim `act`, mesmo em fluxos
// de delegação on-behalf-of.
//
// WORKAROUND adotado nesta PoC:
// Como o `act` claim não está disponível, usamos uma heurística baseada em
// claims que JÁ existem no token emitido pelo Keycloak 26.2:
//
//   - `azp` (Authorized Party) !== `sub` (Subject)
//       -> indica que quem foi autorizado a usar o token (o client/agente)
//          é diferente do dono do token (o usuário). Isso é o sinal de que
//          há um agente atuando em nome de um usuário.
//   - `azp === API_CLIENT_ID` ou um client-id de agente conhecido (ex.: "wgid-agent-v1")
//       -> identifica especificamente qual agente está fazendo a chamada.
//   - `preferred_username` / `email`
//       -> identifica o usuário delegante (o "ator" real por trás da ação).
//
// QUANDO O KEYCLOAK IMPLEMENTAR O `act` CLAIM:
// Trocar toda a lógica abaixo marcada com "TODO(act-claim)" para usar
// `payload.act?.sub` em vez de `payload.azp`. Isso é o ponto exato de
// migração: a estrutura de auditoria e o middleware foram desenhados para
// que essa troca seja mínima (um campo a mais a checar, sem mudar o
// contrato das funções).
// =============================================================================

import dotenv from 'dotenv';
import { writeAuditLog } from './audit.js';

dotenv.config();

const KEYCLOAK_URL = process.env.KEYCLOAK_URL;
const KEYCLOAK_INTERNAL_URL = process.env.KEYCLOAK_INTERNAL_URL || KEYCLOAK_URL;
const REALM = process.env.REALM;
const API_CLIENT_ID = process.env.API_CLIENT_ID;
const API_CLIENT_SECRET = process.env.API_CLIENT_SECRET;

const INTROSPECT_ENDPOINT = `${KEYCLOAK_INTERNAL_URL}/realms/${REALM}/protocol/openid-connect/token/introspect`;
const INTROSPECT_AUTH = 'Basic ' + Buffer.from(`${API_CLIENT_ID}:${API_CLIENT_SECRET}`).toString('base64');

/**
 * Middleware Express que valida o JWT delegado e popula `req.auth`.
 */
export async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token ausente ou malformado' });
  }

  let payload;
  try {
    const resp = await fetch(INTROSPECT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': INTROSPECT_AUTH,
      },
      body: new URLSearchParams({ token }),
    });
    if (!resp.ok) {
      throw new Error(`Introspection endpoint retornou ${resp.status}`);
    }
    const introspection = await resp.json();
    if (!introspection.active) {
      return res.status(401).json({ error: 'Token inválido, expirado ou revogado' });
    }
    payload = introspection;
  } catch (err) {
    return res.status(401).json({ error: 'Falha ao verificar token', detail: err.message });
  }

  const userId = payload.sub;
  const username = payload.preferred_username;
  const email = payload.email;
  const agentId = payload.azp;

  const baseScopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
  const agentScopes = typeof payload.agent_scopes === 'string' ? payload.agent_scopes.split(' ') : [];
  const scopes = Array.from(new Set([...baseScopes, ...agentScopes]));

  // TODO(act-claim): quando disponível, trocar para:
  //   const isDelegated = payload.act?.sub !== undefined;
  const isDelegated = Boolean(agentId) && agentId !== userId;

  req.auth = {
    user_id: userId,
    username,
    email,
    agent_id: agentId,
    scopes,
    is_delegated: isDelegated,
    // Guardamos o payload bruto para uso no audit log (ex.: act_claim_present).
    raw: payload,
  };

  if (!req.auth.is_delegated) {
    return res.status(403).json({
      error: 'Token não delegado — acesso direto de agentes não permitido',
    });
  }

  next();
}

/**
 * Middleware factory que garante que o token possua um scope específico.
 *
 * @param {string} scope - scope OAuth exigido pela rota.
 * @param {object} [audit] - opcional. Quando informado, grava um audit event
 *   com status=Denied caso o scope não esteja presente no token.
 * @param {string} audit.action - nome da ferramenta/ação para o audit log.
 * @param {(req) => string} [audit.resource] - extrai o identificador do
 *   recurso a partir da requisição (ex.: req.body.dataset_id).
 */
export function requireScope(scope, audit) {
  return async (req, res, next) => {
    if (!req.auth?.scopes?.includes(scope)) {
      req.scopeDenied = scope;

      if (audit?.action) {
        await writeAuditLog({
          auth: req.auth,
          action: audit.action,
          resource: audit.resource ? audit.resource(req) : undefined,
          scopeUsed: scope,
          status: 'Denied',
        });
      }

      return res.status(403).json({
        error: `Escopo insuficiente — '${scope}' não concedido no consentimento`,
        scope_required: scope,
      });
    }
    req.scopeUsed = scope;
    next();
  };
}

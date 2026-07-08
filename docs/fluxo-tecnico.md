# Fluxo Técnico da Demonstração

> Detalhamento passo a passo das chamadas HTTP e protocolos envolvidos na PoC. Para uma visão do fluxo do ponto de vista do usuário, veja a seção "Fluxo da Demonstração" no [README](../README.md).

### Etapa 1 — Descoberta do Agente

**URL:** `http://localhost:3000`

O portal chama `GET http://agent:4111/agent-info` e renderiza os agentes disponíveis com seus escopos.

```
Portal → Agente: GET /agent-info
Agente → Portal: {
  id: "wgid-agent-v1",
  name: "Assistente de Análise Genômica",
  requestedScopes: [
    { name: "genomica:read", label: "Leitura de sequências genômicas" },
    { name: "hpc:submit",    label: "Submissão de jobs HPC" }
  ]
}
```

**Componentes envolvidos:** Portal, Agente

**Conceito demonstrado:** Autodescoberta de identidade do agente — o portal não possui configuração estática de escopos; eles são declarados pelo próprio agente.

---

### Etapa 2 — Autenticação da Pesquisadora

**URL:** `http://localhost:3000/login` → redirect para Keycloak

A pesquisadora se autentica via Keycloak (que, na integração completa, redireciona para o Shibboleth IdP da CAFe via SATOSA). O resultado é um **access token** emitido para o client `delegation-portal`, representando a identidade da pesquisadora.

```
Browser → Keycloak: Authorization Code Request
Keycloak → Shibboleth/SATOSA: SAML2 AuthnRequest  [se integrado à CAFe]
Shibboleth → SATOSA → Keycloak: Asserção com atributos
Keycloak → Browser: Authorization Code
Browser → Portal: GET /callback?code=...
Portal → Keycloak: POST /token (code → access_token)
```

**Componentes envolvidos:** Portal, Keycloak, SATOSA (opcional), Shibboleth IdP (opcional)

**Conceito demonstrado:** Autenticação federada — a identidade da pesquisadora é proveniente da instituição de ensino (via CAFe/SAML2), não de um cadastro local no portal.

---

### Etapa 3 — Consentimento e Seleção de Escopos

**URL:** `http://localhost:3000/consent/wgid-agent-v1`

O portal exibe os escopos que o agente solicita, com checkboxes pré-selecionados. A pesquisadora pode desmarcar escopos antes de confirmar, reduzindo o privilégio delegado.

**Componentes envolvidos:** Portal (frontend), Browser

**Conceito demonstrado:** Consentimento granular — alinhado com a abordagem de assistentes de IA no mercado (Google OAuth, Microsoft Entra External ID, Amazon Cognito), onde o usuário decide quais permissões conceder.

---

### Etapa 4 — Token Exchange (RFC 8693)

**URL:** `POST /authorize` (form submit da tela de consentimento)

O portal executa o fluxo de delegação em duas chamadas servidor-a-servidor ao Keycloak:

**Passo 4a — Obter actor token do agente:**
```http
POST /realms/agents/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=wgid-agent-v1
&client_secret=<secret>
```

**Passo 4b — Token Exchange:**
```http
POST /realms/agents/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<token-da-pesquisadora>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&actor_token=<token-do-agente>
&actor_token_type=urn:ietf:params:oauth:token-type:access_token
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&client_id=wgid-agent-v1
&client_secret=<secret>
&scope=genomica:read hpc:submit
&audience=api-server
```

O token resultante tem `sub` = pesquisadora, `azp` = `wgid-agent-v1`, `aud` inclui `api-server`.

**Componentes envolvidos:** Portal, Keycloak

**Conceito demonstrado:** Delegação padronizada via RFC 8693 — o token delegado carrega a identidade da pesquisadora (`sub`) e identifica o agente como parte autorizada (`azp`). A `audience` restringe o uso exclusivamente à API Server.

---

### Etapa 5 — Entrega do Token ao Agente (Push)

Após o Token Exchange, o portal entrega o token ao agente via chamada servidor-a-servidor autenticada:

```http
POST http://agent:4111/token
x-push-secret: <PUSH_SECRET>
Content-Type: application/json

{ "token": "<delegated_token>" }
```

O agente armazena o token em `tokenStore.token` (objeto mutável em memória). A partir deste momento, todas as chamadas de ferramentas usam este token.

**Componentes envolvidos:** Portal, Agente

**Conceito demonstrado:** Entrega segura sem intervenção manual — nenhuma cópia e colagem de token. O `PUSH_SECRET` garante que apenas o portal autorizado pode atualizar o token do agente.

---

### Etapa 6 — Uso do Token pelo Agente

A pesquisadora interage com o agente via Mastra Studio ou API. O agente chama as ferramentas disponíveis, que incluem o token delegado em cada requisição à API:

**Ferramenta `buscarSequencias`:**
```http
GET /api/datasets/WGID-001/sequences
Authorization: Bearer <delegated_token>
```

**Ferramenta `submeterJob`:**
```http
POST /api/jobs/submit
Authorization: Bearer <delegated_token>
Content-Type: application/json

{ "parametros": { "threads": 8, "memoria": "16GB" } }
```

**Componentes envolvidos:** Agente, API Server, Keycloak

**Conceito demonstrado:** Acesso autorizado com identidade delegada — a API vê a identidade da pesquisadora no token, não um service account anônimo.

---

### Etapa 7 — Validação via Token Introspection (RFC 7662)

Para **cada requisição** recebida, a API Server consulta o Keycloak:

```http
POST /realms/agents/protocol/openid-connect/token/introspect
Authorization: Basic <api-server:secret em base64>
Content-Type: application/x-www-form-urlencoded

token=<delegated_token>
```

Resposta do Keycloak:
```json
{
  "active": true,
  "sub": "<uuid-da-pesquisadora>",
  "azp": "wgid-agent-v1",
  "scope": "genomica:read hpc:submit",
  "preferred_username": "ana.silva@ufrn.br",
  "exp": 1751490000
}
```

A API extrai `sub`, `azp`, `scope` e registra no audit log:

```json
{
  "timestamp": "2026-07-02T14:23:01.000Z",
  "user": "ana.silva@ufrn.br",
  "agent": "wgid-agent-v1",
  "is_delegated": true,
  "action": "buscar-sequencias",
  "resource": "WGID-001",
  "scope_used": "genomica:read",
  "status": "Success",
  "act_claim_present": false
}
```

**Componentes envolvidos:** API Server, Keycloak

**Conceito demonstrado:** Validação stateful — ao contrário da validação JWT local (que ignora revogação), a introspection consulta o Keycloak a cada chamada, garantindo que tokens revogados sejam rejeitados imediatamente.

---

### Etapa 8 — Revogação

**URL:** `http://localhost:3000/delegations` → botão "Revogar"

```http
POST /revoke
```

O portal executa:
1. Chama `POST /realms/agents/protocol/openid-connect/revoke` no Keycloak
2. Remove `delegated_token` da sessão local

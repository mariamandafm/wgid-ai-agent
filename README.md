# PoC: Delegação de Identidade Federada para Agentes de IA via RFC 8693

**Contexto:** GIdLab / RNP — CAFe Expresso  
**Objetivo:** Demonstrar que permissões federadas de um usuário, expressas como entitlements AARC-G069 e transportadas via SAML, podem ser delegadas a agentes de IA com escopo reduzido e cadeia de delegação rastreável, usando o Token Exchange do OAuth 2.0 (RFC 8693), sem modificar o protocolo SAML nem a infraestrutura da federação.

---

## 1. Problema

O protocolo SAML 2.0, base da federação CAFe, foi projetado para autenticar sujeitos humanos. Quando um agente de IA acessa recursos federados em nome de um usuário usando os mecanismos disponíveis hoje — API keys estáticas, service accounts compartilhados ou repasse direto de tokens — a identidade do usuário original desaparece no momento da ação do agente. O log de auditoria do Shibboleth não distingue acesso humano de acesso agêntico, e a cadeia de responsabilidade exigida pelo SIRTFI e pela LGPD (Arts. 20 e 37) fica interrompida.

---

## 2. Arquitetura da PoC

```
┌────────────────────────────────────────────────────────────────────┐
│                        GIdLab / CAFe Expresso                      │
│                                                                    │
│  Pesquisadora ──► Shibboleth IdP ──► SATOSA Proxy                  │
│       │              (UFRN sim.)     SAML → OIDC                   │
│       │                   │          ePE → claims                  │
│       │                   ▼                │                       │
│       │             Keycloak AS ◄──────────┘                       │
│       │          (Identity Broker                                   │
│       │           Agent Registry                                    │
│       │           RFC 8693 Token Exchange)                          │
│       │                   │                                        │
│       ▼                   ▼                                        │
│  Portal de ──────► token delegado ──────► API                      │
│  Delegação         sub=pesquisadora      (valida act claim)        │
│                    act=agente            ► Audit Log               │
│                    scope=reduzido        ► SP / API                │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 Componentes

| Componente | Tecnologia | Papel na PoC |
|---|---|---|
| **Shibboleth IdP** | Shibboleth IdP v4/v5 | Autentica a pesquisadora; emite asserção SAML com `eduPersonEntitlement` AARC-G069 |
| **SATOSA Proxy** | SATOSA + pyFF | Traduz asserção SAML para token OIDC; mapeia `eduPersonEntitlement` para claims OIDC como `eduperson_entitlement` |
| **Keycloak AS** | Keycloak 26.5+ | Atua como Identity Broker (recebe identidade federada via SATOSA), Agent Registry (registra agentes como OAuth clients) e executor do Token Exchange RFC 8693 |
| **Portal de Delegação** | FastAPI + Jinja2 | Interface web onde a pesquisadora visualiza agentes disponíveis, consente com escopos e dispara o token exchange |
| **Agente de IA** | Python + httpx | Cliente que usa o token delegado para acessar recursos em nome da pesquisadora |
| **API** | FastAPI | Servidor de ferramentas que valida o token delegado, verifica o `act` claim e registra o audit event |
| **SP / API de recurso** | sp-python.cafeexpresso.rnp.br / waldur.gidlab.rnp.br | Service Providers reais do GIdLab que recebem o token delegado |

---

## 3. Fluxo de Delegação

### 3.1 Fase 0 — Configuração prévia (única vez, pelo administrador)

```
1. Registrar o agente como OAuth client no Keycloak
   - Client ID:     agente-genomica-v1
   - Grant types:   client_credentials, token-exchange
   - Scopes:        genomica:read, hpc:submit
     (subconjunto do eduPersonEntitlement da pesquisadora)

2. Configurar SATOSA como Identity Provider externo no Keycloak
   - Alias:  shibboleth-ufrn
   - Mapper: eduPersonEntitlement → claim OIDC eduperson_entitlement

3. Configurar o Shibboleth IdP para liberar
   eduPersonEntitlement ao SATOSA
```

### 3.2 Fase 1 — Autenticação federada da pesquisadora

```
Pesquisadora
  → acessa o Portal de Delegação
  → clica em "Entrar com conta institucional"
  → redirecionada ao Shibboleth IdP (UFRN simulado no GIdLab)
  → autentica com login institucional
  → Shibboleth emite asserção SAML:
      eduPersonEntitlement:
        urn:mace:aarc:group:vo.genomica.br:role=pesquisador#perun.rnp.br
  → SATOSA converte para token OIDC:
      eduperson_entitlement: [
        "urn:mace:aarc:group:vo.genomica.br:role=pesquisador#perun.rnp.br"
      ]
  → Keycloak recebe token OIDC da pesquisadora via Identity Broker
```

### 3.3 Fase 2 — Delegação ao agente (tela de consentimento)

```
Portal exibe ao usuário:
  ┌─────────────────────────────────────────────────┐
  │  🤖 Assistente de Análise Genômica              │
  │  Este assistente irá:                           │
  │    ✓ Ler sequências (genomica:read)             │
  │    ✓ Submeter jobs HPC (hpc:submit)             │
  │  NÃO poderá:                                    │
  │    ✗ Exportar dados                             │
  │    ✗ Modificar configurações                    │
  │  Validade: 30 dias  |  Revogável a qualquer     │
  │                        momento                  │
  │  [Autorizar]  [Cancelar]                        │
  └─────────────────────────────────────────────────┘

Ao clicar em "Autorizar", o portal executa RFC 8693 Token Exchange:

POST /realms/gidlab-agents/protocol/openid-connect/token
  grant_type:       urn:ietf:params:oauth:grant-type:token-exchange
  client_id:        agente-genomica-v1
  client_secret:    ***
  subject_token:    {token_pesquisadora}
  subject_token_type: urn:ietf:params:oauth:token-type:access_token
  actor_token:      {token_agente}
  actor_token_type: urn:ietf:params:oauth:token-type:access_token
  scope:            genomica:read hpc:submit
  audience:         waldur.gidlab.rnp.br
```

### 3.4 Fase 3 — Token delegado resultante

```json
{
  "sub":   "ana@ufrn.br",
  "act":   { "sub": "agente-genomica-v1" },
  "scope": "genomica:read hpc:submit",
  "eduperson_entitlement": [
    "urn:mace:aarc:group:vo.genomica.br:role=pesquisador#perun.rnp.br"
  ],
  "aud":   "waldur.gidlab.rnp.br",
  "iss":   "https://keycloak.gidlab.rnp.br/realms/gidlab-agents",
  "exp":   1748000000,
  "iat":   1747996400
}
```

> **Propriedade central:** `sub` preserva a identidade federada original da pesquisadora; `act.sub` identifica o agente como ator da ação; `eduperson_entitlement` transporta o entitlement AARC-G069 original sem conversão para scope — mantendo a rastreabilidade até a fonte federada.

### 3.5 Fase 4 — Agente acessa o recurso

```
Agente
  → verifica o token recebido (decodificação local, sem chamada de rede)
  → confirma: scope contém genomica:read ✓
  → confirma: token não expirado ✓

  → GET /api/datasets/DS-2026-03/sequences
    Authorization: Bearer {token_delegado}

API
  → valida JWT localmente via JWKS do Keycloak (cache)
  → extrai: subject=ana@ufrn.br, actor=agente-genomica-v1
  → verifica: scope ⊇ genomica:read ✓
  → grava audit event (ver Seção 4)
  → retorna os dados
```

---

## 4. Modelo de Auditoria

### 4.1 Audit event proposto (extensão do formato atual do Shibboleth)

```json
{
  "timestamp":        "2026-06-03T14:22:31Z",
  "user":             "ana@ufrn.br",
  "agent":            "agente-genomica-v1",
  "is_agent_access":  true,
  "delegated_by":     "ana@ufrn.br",
  "delegation_scope": "genomica:read hpc:submit",
  "entitlement_source": "urn:mace:aarc:group:vo.genomica.br:role=pesquisador#perun.rnp.br",
  "action":           "genomica:read",
  "resource":         "waldur.gidlab.rnp.br/datasets/DS-2026-03",
  "sp_entity_id":     "waldur.gidlab.rnp.br",
  "chain_hash":       "sha256:abc123...",
  "status":           "Success"
}
```

### 4.2 Comparação com o audit.log atual do Shibboleth

| Campo | audit.log atual | Audit event proposto |
|---|---|---|
| Usuário humano | `user=aluno` | `user=ana@ufrn.br` |
| Identificação do agente | ❌ ausente | `agent=agente-genomica-v1` |
| Tipo de acesso | ❌ ausente | `is_agent_access=true` |
| Quem delegou | ❌ ausente | `delegated_by=ana@ufrn.br` |
| Escopo delegado | ❌ ausente | `delegation_scope=genomica:read` |
| Entitlement federado original | ❌ ausente | `entitlement_source=urn:mace:aarc:...` |
| Hash da cadeia | ❌ ausente | `chain_hash=sha256:abc123` |

---

## 5. Estrutura de Diretórios da PoC

```
poc-iam-agentes/
│
├── docker-compose.yml          # orquestra todos os componentes
├── README.md
│
├── idp/                        # Shibboleth IdP (simulado)
│   ├── conf/
│   │   ├── attribute-resolver.xml
│   │   └── attribute-filter.xml
│   └── Dockerfile
│
├── satosa/                     # Proxy SATOSA
│   ├── proxy_conf.yaml
│   ├── internal_attributes.yaml
│   └── plugins/
│       ├── saml2_backend.yaml  # recebe do Shibboleth
│       └── oidc_frontend.yaml  # entrega ao Keycloak
│
├── keycloak/                   # Authorization Server
│   ├── realm-export.json       # realm gidlab-agents pré-configurado
│   │                           # inclui: Identity Broker, clients dos agentes,
│   │                           # escopos e mappers de entitlement
│   └── Dockerfile
│
├── portal/                     # Portal de Delegação
│   ├── main.py                 # FastAPI — fluxo de consentimento
│   ├── templates/
│   │   ├── index.html          # tela de agentes disponíveis
│   │   └── consent.html        # tela de consentimento
│   ├── token_exchange.py       # executa RFC 8693 via Keycloak
│   └── Dockerfile
│
├── api_server/                 # API (recurso protegido)
│   ├── main.py                 # FastAPI — valida act claim, grava audit
│   ├── auth.py                 # validação JWT + extração da cadeia
│   ├── audit.py                # registro do audit event estendido
│   └── Dockerfile
│
├── agente/                     # Agente de IA
│   ├── agente.py               # cliente Python que usa o token delegado
│   ├── tools.py                # ferramentas via API (buscar dados, submeter job)
│   └── Dockerfile
│
└── scripts/
    ├── setup.sh                # configura o ambiente do GIdLab
    ├── demo.sh                 # executa o fluxo completo de demonstração
    └── measure_latency.py      # mede latência adicionada pelo token exchange
```

---

## 6. O que a PoC demonstra

### 6.1 Resultado 1 — Identidade própria do agente

O agente possui `client_id` registrado no Keycloak distinto do usuário. O token do agente tem `sub=agente-genomica-v1` — não `sub=ana@ufrn.br`. Demonstra que agentes **não devem ser modelados como usuários**, mas como OAuth clients com identidade própria.

### 6.2 Resultado 2 — Cadeia de delegação preservada

O token delegado contém simultaneamente `sub=ana@ufrn.br` (quem autorizou) e `act.sub=agente-genomica-v1` (quem age). O SP recebe os dois e pode registrar a cadeia completa. Demonstra que a identidade da pesquisadora **não desaparece** no momento da ação do agente.

### 6.3 Resultado 3 — Princípio do menor privilégio

O agente recebe `scope=genomica:read hpc:submit` — subconjunto estrito dos entitlements da pesquisadora. O Keycloak rejeita token exchange com scopes além do que a pesquisadora possui. Demonstra que a delegação é **sempre menor ou igual**, nunca maior.

### 6.4 Resultado 4 — Entitlement federado preservado no token

O `eduperson_entitlement` com o URN AARC-G069 original viaja no token delegado — não apenas o scope derivado. O SP pode verificar a origem federada da permissão. Demonstra que a **semântica federada é preservada** através da cadeia de delegação.

### 6.5 Resultado 5 — Audit trail rastreável

O audit event gerado pela API contém todos os campos ausentes no `audit.log` atual do Shibboleth. A cadeia `pesquisadora → agente → ação → recurso` é reconstituível a partir de um único evento. Demonstra conformidade com SIRTFI e LGPD Arts. 20 e 37.

---

## 7. Métricas de Avaliação

| Métrica | Como medir | Ferramenta |
|---|---|---|
| Latência do token exchange | Tempo da requisição RFC 8693 (P50, P95, P99) | `time.perf_counter()` + Locust |
| Latência total de autenticação | Shibboleth login até token delegado disponível | Locust |
| Overhead da API | Tempo de validação JWT + gravação audit | `time.perf_counter()` |
| Presença do `act` claim | Inspecionar JWT decodificado | `python-jose` |
| Rejeição de token não-delegado | Taxa de HTTP 403 para tokens sem `act` | Pytest |
| Completude do audit trail | Campos presentes vs. ausentes | Comparação com audit.log Shibboleth |
| Tamanho do token | Bytes do JWT com e sem `eduperson_entitlement` | `len(token.encode())` |

---

## 8. Limitações do Escopo

Esta PoC **não** cobre:

- **SPs SAML da CAFe:** o token delegado só funciona em SPs OIDC que confiam no Keycloak do GIdLab. SPs SAML exigiriam o SATOSA como bridge OIDC→SAML — identificado como trabalho futuro.
- **Cadeias de sub-agentes:** o fluxo demonstra delegação de um salto (pesquisadora → agente). Delegação multi-hop (agente → sub-agente) requer o `draft-mw-spice-actor-chain` — ainda sem implementação de referência.
- **Revogação em tempo real:** se a pesquisadora perder o entitlement na CAFe (ex.: projeto encerrado no Perun), o token delegado permanece válido até o TTL. A propagação via SCIM é identificada como trabalho futuro.
- **Consentimento dinâmico (RS Challenge):** o `draft-oauth-ai-agents-on-behalf-of-user-02` prevê que o próprio SP dispare o fluxo de delegação quando necessário. Não implementado no Keycloak ainda.

---

## 9. Relação com Padrões e Trabalhos Relacionados

| Padrão / Trabalho | Relação com a PoC |
|---|---|
| RFC 8693 — OAuth 2.0 Token Exchange | Mecanismo central de delegação |
| RFC 7519 — JWT | Formato dos tokens |
| RFC 9449 — DPoP | Extensão de segurança — trabalho futuro |
| draft-ietf-oauth-identity-chaining | Fundamento normativo do papel do Keycloak como Identity Broker cross-domain |
| draft-oauth-ai-agents-on-behalf-of-user-02 | Alternativa com RS Challenge — comparação na seção de trabalhos relacionados |
| AARC-G069 | Formato dos entitlements federados preservados no token |
| AARC-JRA1.4E (G006) | Modelo de Information Sources — a PoC implementa extensão do Modelo A para agentes |
| AARC-BPA-2025 | Arquitetura de referência — Keycloak mapeia para a Authorisation Layer |
| Agentic JWT (arXiv:2509.13597) | Abordagem alternativa por checksum de configuração — comparação |
| HDP (arXiv:2604.04522) | Complementar — proveniência offline — trabalho futuro |
| SIRTFI | Requisito de rastreabilidade — satisfeito pelo audit event proposto |
| LGPD Arts. 20 e 37 | Conformidade com decisões automatizadas e registros de tratamento |

---

## 10. Pré-requisitos de Infraestrutura no GIdLab

- Shibboleth IdP v4/v5 já disponível na CAFe Expresso
- SATOSA já disponível no GIdLab (usado em artigos WGID 2023/2025)
- Keycloak já disponível no GIdLab (ambiente OIDC existente)
- Docker + Docker Compose no host de desenvolvimento
- Acesso aos SPs `waldur.gidlab.rnp.br` e `sp-python.cafeexpresso.rnp.br`
- Keycloak versão mínima: **26.2** (Token Exchange habilitado nativamente)
- Keycloak versão recomendada: **26.5** (suporte ao draft identity-chaining)
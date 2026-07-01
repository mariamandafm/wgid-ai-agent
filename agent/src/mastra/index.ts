
import { Mastra } from '@mastra/core/mastra';
import { tokenStore } from './token-store';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, MastraStorageExporter, MastraPlatformExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { weatherAgent } from './agents/weather-agent';
import { wgidAgent } from './agents/wgid-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';

export const mastra = new Mastra({
  server: {
    apiRoutes: [
      {
        path: '/token',
        method: 'POST',
        handler: async (c: any) => {
          const secret = c.req.header('x-push-secret');
          if (!secret || secret !== process.env.PUSH_SECRET) {
            return c.json({ error: 'unauthorized' }, 401);
          }
          const body = await c.req.json();
          if (!body?.token) {
            return c.json({ error: 'token ausente' }, 400);
          }
          tokenStore.token = body.token;
          return c.json({ ok: true });
        },
      },
      {
        path: '/agent-info',
        method: 'GET',
        handler: async (c: any) => {
          return c.json({
            id: 'wgid-agent-v1',
            name: 'Assistente de Análise Genômica',
            description: 'Agente de IA que auxilia pesquisadoras na análise de dados genômicos e submissão de jobs em clusters HPC.',
            requestedScopes: [
              {
                name: 'genomica:read',
                label: 'Leitura de sequências genômicas',
                description: 'Permite buscar e ler dados de sequenciamento do repositório federado.',
              },
              {
                name: 'hpc:submit',
                label: 'Submissão de jobs HPC',
                description: 'Permite submeter trabalhos de análise em clusters de alto desempenho.',
              },
            ],
          });
        },
      },
    ],
  },
  workflows: { weatherWorkflow },
  agents: { weatherAgent, wgidAgent },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: "mastra-storage",
      url: "file:./mastra.db",
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    }
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});

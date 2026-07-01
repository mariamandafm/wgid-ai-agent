import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { tokenStore } from '../token-store'

const API = process.env.API_SERVER_URL ?? 'http://api_server:3001'

export const buscarSequencias = createTool({
  id: 'buscar-sequencias',
  description: 'Busca sequências genômicas do repositório federado',
  inputSchema: z.object({
    dataset_id: z.string()
  }),
  execute: async (inputData) => {
    const resp = await fetch(
      `${API}/api/datasets/${encodeURIComponent(inputData.dataset_id)}/sequences`,
      { headers: { Authorization: `Bearer ${tokenStore.token}` } }
    )
    if (!resp.ok) {
      throw new Error(`API retornou ${resp.status} ao buscar sequências`)
    }
    return resp.json()
  }
})

export const submeterJob = createTool({
  id: 'submeter-job',
  description: 'Submete job de análise no cluster HPC',
  inputSchema: z.object({
    parametros: z.record(z.string(), z.unknown())
  }),
  execute: async (inputData) => {
    const resp = await fetch(`${API}/api/jobs/submit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenStore.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(inputData)
    })
    if (!resp.ok) {
      throw new Error(`API retornou ${resp.status} ao submeter job`)
    }
    return resp.json()
  }
})
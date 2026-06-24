import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

const TOKEN = process.env.DELEGATED_TOKEN ?? ''
const API   = process.env.API_SERVER_URL ?? 'http://api_server:3001'

export const buscarSequencias = createTool({
  id: 'buscar-sequencias',
  description: 'Busca sequências genômicas do repositório federado',
  inputSchema: z.object({
    dataset_id: z.string()
  }),
  execute: async (inputData) => {
    const resp = await fetch(
      `${API}/api/datasets/${encodeURIComponent(inputData.dataset_id)}/sequences`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    )
    if (!resp.ok) {
      throw new Error(`API retornou ${resp.status} ao buscar sequências`)
    }
    return resp.json()
  }
})

// export const submeterJob = createTool({
//   id: 'submeter-job',
//   description: 'Submete job de análise no cluster HPC',
//   inputSchema: z.object({
//     parametros: z.record(z.unknown())
//   }),
//   execute: async (inputData) => {
//     const resp = await fetch(`${API}/api/jobs/submit`, {
//       method: 'POST',
//       headers: {
//         Authorization: `Bearer ${TOKEN}`,
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify(inputData.parametros)
//     })
//     if (!resp.ok) {
//       throw new Error(`API retornou ${resp.status} ao submeter job`)
//     }
//     return resp.json()
//   }
// })
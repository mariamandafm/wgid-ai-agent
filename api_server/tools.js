import { writeAuditLog } from './audit.js';

function randomJobId() {
  const n = Math.floor(Math.random() * 100000);
  return `slurm-${String(n).padStart(5, '0')}`;
}

/**
 * GET /api/datasets/:dataset_id/sequences
 * Requer scope genomica:read.
 */
export async function buscarSequencias(req, res) {
  const { dataset_id } = req.params;

  const resultado = {
    dataset_id,
    organismo: 'Homo sapiens',
    total_sequencias: 1280,
    formato: 'FASTA',
    sequencias_amostra: [
      { id: 'seq_0001', tamanho_bp: 2451 },
      { id: 'seq_0002', tamanho_bp: 1893 },
      { id: 'seq_0003', tamanho_bp: 3120 },
    ],
  };

  await writeAuditLog({
    auth: req.auth,
    action: 'buscar-sequencias',
    resource: dataset_id,
    scopeUsed: req.scopeUsed,
    status: 'Success',
  });

  res.json(resultado);
}

/**
 * POST /api/jobs/submit
 * Requer scope hpc:submit.
 */
export async function submeterJob(req, res) {
  const { parametros } = req.body || {};

  const resultado = {
    job_id: randomJobId(),
    status: 'submitted',
    estimativa: '2h30min',
  };

  await writeAuditLog({
    auth: req.auth,
    action: 'submeter-job',
    resource: resultado.job_id,
    scopeUsed: req.scopeUsed,
    status: 'Success',
  });

  res.json(resultado);
}

/**
 * GET /api/datasets/:dataset_id/export
 * Requer scope genomica:export. Esse scope nunca é concedido no consentimento
 * desta PoC, então o middleware requireScope sempre nega antes de chegar
 * aqui — esse handler existe apenas para o caso (hipotético, fora do escopo
 * da PoC) em que o scope tenha sido concedido.
 */
export async function exportarDados(req, res) {
  const { dataset_id } = req.params;

  const resultado = {
    dataset_id,
    export_url: `https://export.example.org/datasets/${dataset_id}.tar.gz`,
    status: 'exported',
  };

  await writeAuditLog({
    auth: req.auth,
    action: 'exportar-dados',
    resource: dataset_id,
    scopeUsed: req.scopeUsed,
    status: 'Success',
  });

  res.json(resultado);
}

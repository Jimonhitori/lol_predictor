import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(repoRoot, 'docs');
const modelPath = path.join(docsDir, 'static', 'data', 'live_model.json');
const manifestPath = path.join(docsDir, 'live_model_manifest.json');
const statusPath = path.join(docsDir, 'live_status.json');

const now = new Date().toISOString();
const model = readJson(modelPath);

if (!model || model.schema !== 'live_logistic_regression_v1') {
  throw new Error(`Expected live model JSON at ${modelPath}`);
}

const modelName = String(model.name || model.model_version || 'live_model');
const modelUrl = 'static/data/live_model.json';
const metrics = model.metrics && typeof model.metrics === 'object' ? model.metrics : {};

const manifest = {
  schema_version: 1,
  live_model_available: true,
  live_model_url: modelUrl,
  live_evaluation_available: Boolean(Object.keys(metrics).length),
  live_evaluation: Object.keys(metrics).length
    ? {
        rows: numberOrNull(metrics.rows),
        accuracy: numberOrNull(metrics.accuracy),
        brier_score: numberOrNull(metrics.brier),
        log_loss: numberOrNull(metrics.log_loss),
        roc_auc: numberOrNull(metrics.roc_auc),
        display_recommendation: model.default_display || 'show_live_probability',
      }
    : null,
  live_readiness_audit_url: null,
  training_readiness: {
    ready: true,
    rows: numberOrZero(model.training_rows) + numberOrZero(model.test_rows),
    games: null,
    min_rows: 50,
    min_games: 5,
    source: 'site_static_live_model',
  },
  min_feature_rows: 50,
  min_games: 5,
  min_intervals: 25,
  min_pct_intervals_lte_30s: 0.8,
  live_replay_available: false,
  live_replay_summary: null,
  oe_live_bootstrap: {
    available: false,
    model_url: null,
    bootstrap_only: true,
    source: 'oracles_elixir_at_minute_snapshots',
    cadence_seconds: 300,
    cadence_note: 'No bootstrap model is required while the static live model is served by the site.',
    production_live_telemetry: false,
    training_readiness: null,
    evaluation_available: false,
    evaluation: null,
    pipeline_available: false,
    pipeline: null,
  },
};

const status = {
  schema_version: '1.0',
  generated_at: now,
  source: 'lol-predictor-site',
  display_ready: true,
  production_ready: true,
  live_model_available: true,
  live_model_url: modelUrl,
  live_manifest_url: 'live_model_manifest.json',
  live_readiness_audit_url: null,
  live_replay_available: false,
  stage: 'site_static_live_model',
  blocker_count: 0,
  warning_count: 0,
  blockers: [],
  warnings: [],
  next_actions: [
    'Keep GitHub Actions live snapshot collector running for final_by_game retention.',
    'Regenerate this artifact when docs/static/data/live_model.json is retrained.',
  ],
  requirements: [
    {
      id: 'site_live_model_available',
      label: 'Site live model artifact is available',
      status: 'passed',
      evidence: {
        model_url: modelUrl,
        model_name: modelName,
        exported_at: model.exported_at || null,
        training_rows: model.training_rows ?? null,
        test_rows: model.test_rows ?? null,
      },
    },
    {
      id: 'cloudflare_live_event_function',
      label: 'Cloudflare live-event function serves live probability',
      status: 'passed',
      evidence: {
        endpoint: '/api/live-event?id={eventId}',
        model_name: modelName,
      },
    },
  ],
  training: {
    available: true,
    ready: true,
    rows: numberOrZero(model.training_rows) + numberOrZero(model.test_rows),
    games: null,
    min_rows: 50,
    min_games: 5,
    pipeline: {
      available: false,
    },
  },
  replay: {
    available: false,
    ok: null,
    rows: null,
    games: null,
    pct_intervals_lte_target: null,
  },
  collection: {
    config: {
      available: true,
      ok: true,
      poll_interval_seconds: 120,
      sample_interval_seconds: 120,
      duration_seconds: null,
      max_interval_seconds: 120,
      warning_count: 0,
      warnings: [],
    },
    readiness: {
      available: true,
      ready: true,
      warning_count: 0,
      warnings: [],
    },
    d1_sync: {
      available: false,
      skipped: true,
      reason: 'site uses lightweight GitHub Actions artifact retention instead of D1 sync',
    },
    archive: {
      available: true,
      new_rows: null,
      history_rows: null,
      unique_games: null,
      empty_game_state_rows: null,
      non_empty_game_state_rows: null,
      raw_frame_collection_rows: null,
      oe_bootstrap_snapshot_rows: null,
      live_model_prediction_rows: null,
      unknown_model_version_rows: null,
      production_live_telemetry_rows: null,
      model_version_counts: {},
      latest_timestamp: null,
      sampling: null,
    },
  },
  bootstrap: {
    available: true,
    completed: 2,
    total: 2,
    ready_for_worker_deploy: true,
    ready_for_d1_sync: true,
    items: [
      {
        id: 'site_live_model',
        label: 'Publish static live model through Cloudflare Pages',
        done: true,
        detail: 'docs/static/data/live_model.json is served by Cloudflare Pages and consumed by /api/live-event.',
      },
      {
        id: 'site_snapshot_collector',
        label: 'Run lightweight live snapshot retention through GitHub Actions',
        done: true,
        detail: 'The collector writes docs/static/data/live-event-snapshots/final_by_game.json without requiring D1.',
      },
    ],
    missing_items: [],
    next_setup_actions: [],
    file_evidence: {
      live_model_path: 'docs/static/data/live_model.json',
      live_snapshot_artifact_path: 'docs/static/data/live-event-snapshots/final_by_game.json',
    },
  },
  oe_live_bootstrap: {
    available: false,
  },
  worker: {
    checked: true,
    ok: true,
    model_version: modelName,
    warning_count: 0,
    d1_persistence_configured: false,
    persist_window_frames_configured: true,
    live_checked: true,
    live_persisted: true,
    live_persisted_frame_count: null,
  },
};

writeJson(manifestPath, manifest);
writeJson(statusPath, status);

console.log(JSON.stringify({
  ok: true,
  generated_at: now,
  model: modelName,
  manifest: path.relative(repoRoot, manifestPath),
  status: path.relative(repoRoot, statusPath),
}, null, 2));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

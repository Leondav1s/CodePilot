import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting, getDb } from '@/lib/db';
import { findClaudeBinary } from '@/lib/platform';

export async function GET() {
  try {
    // Check if setup was already completed
    const completedRaw = getSetting('setup_completed');
    const completed = completedRaw === 'true';

    // Claude status
    let claude: 'not-configured' | 'completed' | 'skipped' | 'needs-fix' = 'not-configured';
    const claudeSkipped = getSetting('setup_claude_skipped');
    if (claudeSkipped === 'true') {
      claude = 'skipped';
    } else {
      try {
        const binary = findClaudeBinary();
        claude = binary ? 'completed' : 'not-configured';
      } catch {
        claude = 'not-configured';
      }
    }

    // Provider status — always check real credentials first, skipped is only a fallback
    let provider: 'not-configured' | 'completed' | 'skipped' | 'needs-fix' = 'not-configured';
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as cnt FROM api_providers').get() as { cnt: number } | undefined;
    if (row && row.cnt > 0) {
      provider = 'completed';
    } else {
      // Check env-based or app-settings-based credentials
      const appToken = getSetting('anthropic_auth_token');
      if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || appToken) {
        provider = 'completed';
      } else {
        // Check if Claude Code CLI is available — it acts as a provider via SDK proxy
        // (the built-in 'env' provider in /api/providers/models always lists Claude Code,
        // so we must recognise the CLI as a valid provider to keep the UI consistent)
        try {
          const binary = findClaudeBinary();
          if (binary) {
            provider = 'completed';
          }
        } catch {
          // CLI not found — continue to fallback
        }

        if (provider === 'not-configured') {
          // No real provider found — check if user previously skipped setup
          const providerSkipped = getSetting('setup_provider_skipped');
          provider = providerSkipped === 'true' ? 'skipped' : 'not-configured';
        }
      }
    }

    // Project status
    let project: 'not-configured' | 'completed' | 'skipped' | 'needs-fix' = 'not-configured';
    const projectSkipped = getSetting('setup_project_skipped');
    const defaultProject = getSetting('setup_default_project');
    if (projectSkipped === 'true') {
      project = 'skipped';
    } else if (defaultProject) {
      // Validate path exists
      const fs = await import('fs');
      try {
        const stat = fs.statSync(defaultProject);
        project = stat.isDirectory() ? 'completed' : 'needs-fix';
      } catch {
        project = 'needs-fix';
      }
    }

    return NextResponse.json({
      completed,
      claude,
      provider,
      project,
      defaultProject: defaultProject || undefined,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to get setup state' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { card, status, value } = body;

    if (!card || !status) {
      return NextResponse.json({ error: 'Missing card or status' }, { status: 400 });
    }

    switch (card) {
      case 'claude':
        if (status === 'skipped') setSetting('setup_claude_skipped', 'true');
        else if (status === 'completed') setSetting('setup_claude_skipped', '');
        break;
      case 'provider':
        if (status === 'skipped') setSetting('setup_provider_skipped', 'true');
        else if (status === 'completed') setSetting('setup_provider_skipped', '');
        break;
      case 'project':
        if (status === 'skipped') {
          setSetting('setup_project_skipped', 'true');
        } else if (status === 'completed' && value) {
          setSetting('setup_default_project', value);
          setSetting('setup_project_skipped', '');
        }
        break;
      case 'completed':
        setSetting('setup_completed', 'true');
        break;
      default:
        return NextResponse.json({ error: 'Unknown card' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed to update setup state' }, { status: 500 });
  }
}

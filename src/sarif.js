const SEVERITY_LEVEL = {
  CRITICAL: 'error',
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'note',
  INFO: 'note'
};

const SEVERITY_LABEL = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFO: 'Info'
};

/**
 * Parse YCR findings from model output.
 * Supports:
 *   [HIGH] Title
 *   Location: path:line
 * and Dependabot-ish bullet blocks:
 *   * **Vulnerability Type:** Title
 *   * **Location:** `path`
 */
export function parseFindings(report) {
  if (!report || typeof report !== 'string') return [];

  const bracket = parseBracketFindings(report);
  if (bracket.length > 0) return bracket;

  const bullets = parseBulletFindings(report);
  if (bullets.length > 0) return bullets;

  return [];
}

function parseBracketFindings(report) {
  const findings = [];
  const blockRe =
    /\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s*([^\n]+)\n([\s\S]*?)(?=\n\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\]|\n### Report Generated|$)/gi;

  let match;
  while ((match = blockRe.exec(report)) !== null) {
    const body = match[3] || '';
    const field = (name) => extractField(body, name);
    const locationRaw = field('Location');
    const {file, line} = parseLocation(locationRaw);
    const title = match[2].trim();
    findings.push({
      severity: match[1].toUpperCase(),
      title,
      description: field('Description') || title,
      impact: field('Impact'),
      recommendation: field('Recommendation'),
      owasp: field('OWASP'),
      e2eFlow: field('E2E Flow'),
      source: field('Change/Source') || field('Source'),
      sink: field('Sink'),
      file,
      line,
      rawLocation: locationRaw
    });
  }
  return findings;
}

function parseBulletFindings(report) {
  const section =
    report.match(
      /\*\*Findings?\*\*([\s\S]*?)(?=\n\*\*[A-Z][^*\n]+\*\*|\n### Report Generated|$)/i
    )?.[1] || report;

  // Split on Vulnerability Type bullets (start of each finding).
  const parts = section.split(/\n(?=\s*[-*]\s*\*\*Vulnerability Type:\*\*)/i);
  const findings = [];

  for (const part of parts) {
    if (!/\*\*Vulnerability Type:\*\*/i.test(part)) continue;
    const field = (name) => extractBulletField(part, name);
    const titleRaw = field('Vulnerability Type') || field('Title');
    if (!titleRaw) continue;

    const {title, owaspFromTitle} = splitTitleOwasp(titleRaw);
    const locationRaw =
      field('Location') || field('Path') || field('File') || '';
    const {file, line} = parseLocation(locationRaw);
    const owasp =
      field('OWASP Catalog Item') ||
      field('OWASP') ||
      owaspFromTitle ||
      '';
    const severity =
      inferSeverity(field('Severity') || '', title, field('Impact') || '') ||
      'MEDIUM';

    findings.push({
      severity,
      title,
      description: field('Description') || title,
      impact: field('Impact'),
      recommendation: field('Recommendation') || field('Remediation'),
      owasp,
      e2eFlow: field('E2E Flow') || field('Flow'),
      source: field('Change/Source') || field('Source'),
      sink: field('Sink'),
      file,
      line,
      rawLocation: locationRaw
    });
  }

  return findings;
}

function extractField(body, name) {
  const m = body.match(new RegExp(`^${escapeRegExp(name)}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
}

function extractBulletField(body, name) {
  const m = body.match(
    new RegExp(
      `^\\s*[-*]\\s*\\*\\*${escapeRegExp(name)}:\\*\\*\\s*(.+)$`,
      'im'
    )
  );
  return m ? stripMd(m[1]) : '';
}

function splitTitleOwasp(titleRaw) {
  const m = titleRaw.match(/^(.*?)\s*\(([^)]*OWASP[^)]*)\)\s*$/i);
  if (!m) return {title: titleRaw.trim(), owaspFromTitle: ''};
  return {title: m[1].trim(), owaspFromTitle: m[2].trim()};
}

function inferSeverity(explicit, title, impact) {
  const blob = `${explicit} ${title} ${impact}`.toUpperCase();
  if (/\bCRITICAL\b/.test(blob)) return 'CRITICAL';
  if (/\bHIGH\b/.test(blob)) return 'HIGH';
  if (/\bMEDIUM\b/.test(blob)) return 'MEDIUM';
  if (/\bLOW\b/.test(blob)) return 'LOW';
  if (/\bINFO\b/.test(blob)) return 'INFO';
  return '';
}

function stripMd(s) {
  return String(s)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLocation(raw) {
  if (!raw || /^n\/?a$/i.test(raw)) {
    return {file: undefined, line: undefined};
  }
  const cleaned = stripMd(raw)
    .replace(/^[ab]\//, '')
    .replace(/^\.\//, '');
  // path:line or path:line:col — stop before " (note)"
  const m = cleaned.match(/^([^\s:(]+?\.[A-Za-z0-9]+):(\d+)(?::\d+)?/);
  if (m) {
    return {file: m[1], line: Number(m[2])};
  }
  const pathOnly = cleaned.match(/^([^\s:(]+?\.[A-Za-z0-9]+)/);
  if (pathOnly) {
    return {file: pathOnly[1], line: undefined};
  }
  return {file: cleaned.split(/\s+/)[0] || undefined, line: undefined};
}

/** Prefer a path that exists in the workspace (e.g. index.js → src/index.js). */
export function resolveFindingPath(file, existsFn) {
  if (!file) return undefined;
  if (existsFn(file)) return file;
  const candidates = [`src/${file}`, `lib/${file}`, `app/${file}`];
  for (const c of candidates) {
    if (existsFn(c)) return c;
  }
  return file;
}

/** GitHub code scanning rejects results with zero locations. */
export function buildLocation(file, line, fallbackUri) {
  const uri = (file || fallbackUri || 'README.md').replace(/^\.\//, '');
  const physicalLocation = {
    artifactLocation: {uri, uriBaseId: '%SRCROOT%'}
  };
  if (Number.isInteger(line) && line > 0) {
    physicalLocation.region = {startLine: line};
  } else {
    physicalLocation.region = {startLine: 1};
  }
  return [{physicalLocation}];
}

function ruleIdFor(finding, index) {
  const slug = finding.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return slug ? `ycr-${slug}` : `ycr-${String(index + 1).padStart(3, '0')}`;
}

function helpMarkdown(f) {
  const sev = SEVERITY_LABEL[f.severity] || f.severity;
  const loc = f.file
    ? f.line
      ? `\`${f.file}:${f.line}\``
      : `\`${f.file}\``
    : '_unknown_';

  const rows = [
    `| Severity | ${sev} |`,
    `| Location | ${loc} |`,
    f.owasp ? `| OWASP | ${f.owasp} |` : '',
    f.e2eFlow ? `| Flow | ${f.e2eFlow} |` : '',
    f.source ? `| Source | ${f.source} |` : '',
    f.sink ? `| Sink | ${f.sink} |` : ''
  ]
    .filter(Boolean)
    .join('\n');

  return [
    '## Overview',
    '',
    f.description || f.title,
    '',
    '| | |',
    '| --- | --- |',
    rows,
    '',
    f.impact ? '## Impact\n\n' + f.impact + '\n' : '',
    f.recommendation
      ? '## Remediation\n\n' + f.recommendation + '\n'
      : '',
    '## References',
    '',
    f.owasp ? `- OWASP: ${f.owasp}` : '- Yang Code Review (YCR)',
    '- [yang-code-review](https://github.com/YangYang-Research/yang-code-review)'
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n')
    .trim();
}

function alertTitle(f) {
  const sev = SEVERITY_LABEL[f.severity] || f.severity;
  const where = f.file ? ` in ${f.file}` : '';
  return `${sev} severity - ${f.title}${where}`;
}

export function buildSarif({
  findings,
  reportText,
  owner,
  repo,
  commitSha,
  fallbackUri = 'README.md'
}) {
  const rules = [];
  const results = [];
  const seenRules = new Set();

  findings.forEach((f, index) => {
    const ruleId = ruleIdFor(f, index);
    if (!seenRules.has(ruleId)) {
      seenRules.add(ruleId);
      const sevLabel = (SEVERITY_LABEL[f.severity] || 'medium').toLowerCase();
      rules.push({
        id: ruleId,
        name: f.title.slice(0, 128),
        shortDescription: {text: f.title},
        fullDescription: {
          text: (f.description || f.title).slice(0, 1024)
        },
        help: {
          text: [
            f.description,
            f.impact ? `Impact: ${f.impact}` : '',
            f.recommendation ? `Remediation: ${f.recommendation}` : '',
            f.owasp ? `OWASP: ${f.owasp}` : ''
          ]
            .filter(Boolean)
            .join('\n\n'),
          markdown: helpMarkdown(f)
        },
        defaultConfiguration: {
          level: SEVERITY_LEVEL[f.severity] || 'note'
        },
        properties: {
          tags: [
            'security',
            `severity/${sevLabel}`,
            'owasp',
            'yang-code-review'
          ],
          'security-severity': securitySeverityScore(f.severity),
          precision: 'medium',
          'problem.severity': sevLabel
        }
      });
    }

    results.push({
      ruleId,
      level: SEVERITY_LEVEL[f.severity] || 'note',
      message: {
        text: alertTitle(f)
      },
      locations: buildLocation(f.file, f.line, fallbackUri),
      properties: {
        tags: ['security'],
        'security-severity': securitySeverityScore(f.severity)
      }
    });
  });

  if (results.length === 0 && reportText?.trim()) {
    const fallback = {
      severity: 'INFO',
      title: 'Yang Code Review findings',
      description:
        'Review produced findings that could not be fully structured. See alert details.',
      impact: '',
      recommendation: 'Open the Actions artifact markdown report for the full review.',
      owasp: '',
      e2eFlow: '',
      source: '',
      sink: '',
      file: fallbackUri,
      line: 1
    };
    rules.push({
      id: 'ycr-report',
      name: 'Yang Code Review report',
      shortDescription: {text: 'Yang Code Review report'},
      fullDescription: {
        text: 'Unstructured or partially structured YCR output.'
      },
      help: {
        text: reportText.slice(0, 4000),
        markdown: [
          '## Overview',
          '',
          'Yang Code Review returned a free-form report. Summary below.',
          '',
          '## Details',
          '',
          reportText.slice(0, 60_000)
        ].join('\n')
      },
      defaultConfiguration: {level: 'note'},
      properties: {
        tags: ['security', 'severity/info', 'yang-code-review'],
        'security-severity': '0.0',
        precision: 'low'
      }
    });
    results.push({
      ruleId: 'ycr-report',
      level: 'note',
      message: {text: 'Info severity - Yang Code Review report'},
      locations: buildLocation(fallback.file, 1, fallbackUri),
      properties: {'security-severity': '0.0'}
    });
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'yang-code-review',
            version: '1.0.21',
            informationUri:
              'https://github.com/YangYang-Research/yang-code-review',
            rules
          }
        },
        versionControlProvenance: commitSha
          ? [
              {
                repositoryUri: `https://github.com/${owner}/${repo}`,
                revisionId: commitSha
              }
            ]
          : undefined,
        results
      }
    ]
  };
}

/** Dependabot-style markdown for PR comments. */
export function formatDependabotStyleComment(findings, {reportText} = {}) {
  if (!findings.length) {
    return [
      '## Yang Code Review',
      '',
      '_No structured vulnerabilities parsed. Full report:_',
      '',
      '<details>',
      '<summary>Full report</summary>',
      '',
      reportText || '_empty_',
      '',
      '</details>'
    ].join('\n');
  }

  const counts = {CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const summaryBits = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${SEVERITY_LABEL[k].toLowerCase()}`)
    .join(', ');

  const table = [
    '| Severity | Title | Location |',
    '|:---|:---|:---|',
    ...findings.map((f) => {
      const loc = f.file
        ? f.line
          ? `\`${f.file}:${f.line}\``
          : `\`${f.file}\``
        : '—';
      return `| ${SEVERITY_LABEL[f.severity] || f.severity} | ${f.title.replace(/\|/g, '\\|')} | ${loc} |`;
    })
  ].join('\n');

  const details = findings
    .map((f) => {
      const sev = SEVERITY_LABEL[f.severity] || f.severity;
      return [
        `<details>`,
        `<summary><strong>${sev}</strong> · ${escapeHtml(f.title)}</summary>`,
        '',
        helpMarkdown(f),
        '',
        `</details>`
      ].join('\n');
    })
    .join('\n\n');

  return [
    '## Yang Code Review',
    '',
    `Detected **${findings.length}** vulnerabilit${findings.length === 1 ? 'y' : 'ies'} (${summaryBits}).`,
    '',
    table,
    '',
    details,
    '',
    '_Reported by [yang-code-review](https://github.com/YangYang-Research/yang-code-review)_'
  ].join('\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function securitySeverityScore(severity) {
  switch (severity) {
    case 'CRITICAL':
      return '9.5';
    case 'HIGH':
      return '8.0';
    case 'MEDIUM':
      return '5.5';
    case 'LOW':
      return '3.0';
    default:
      return '0.0';
  }
}

export function reportDateStamp(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function buildArtifactName({date, pullNumber}) {
  const stamp = typeof date === 'string' ? date : reportDateStamp(date);
  if (pullNumber != null && pullNumber !== '') {
    return `yang-code-review-report-${stamp}-pr-${pullNumber}`;
  }
  return `yang-code-review-report-${stamp}`;
}

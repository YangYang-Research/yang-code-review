const SEVERITY_LEVEL = {
  CRITICAL: 'error',
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'note',
  INFO: 'note'
};

/**
 * Parse YCR markdown findings into structured rows.
 * Expects blocks like:
 *   [HIGH] XSS
 *   OWASP: ...
 *   Location: path/file.js:42
 */
export function parseFindings(report) {
  if (!report || typeof report !== 'string') return [];

  const findings = [];
  const blockRe =
    /\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s*([^\n]+)\n([\s\S]*?)(?=\n\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\]|\n### Report Generated|$)/gi;

  let match;
  while ((match = blockRe.exec(report)) !== null) {
    const severity = match[1].toUpperCase();
    const title = match[2].trim();
    const body = match[3] || '';

    const field = (name) => {
      const m = body.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
      return m ? m[1].trim() : '';
    };

    const locationRaw = field('Location');
    const {file, line} = parseLocation(locationRaw);
    const description = field('Description') || title;
    const recommendation = field('Recommendation');
    const owasp = field('OWASP');

    findings.push({
      severity,
      title,
      description,
      recommendation,
      owasp,
      file,
      line,
      rawLocation: locationRaw
    });
  }

  return findings;
}

function parseLocation(raw) {
  if (!raw || /^n\/?a$/i.test(raw)) {
    return {file: undefined, line: undefined};
  }
  const m = raw.match(/^(.+?):(\d+)(?::\d+)?\s*$/);
  if (!m) {
    return {file: raw.replace(/^[ab]\//, ''), line: undefined};
  }
  return {
    file: m[1].replace(/^[ab]\//, '').replace(/^\.\//, ''),
    line: Number(m[2])
  };
}

/** GitHub code scanning rejects results with zero locations. */
export function buildLocation(file, line, fallbackUri) {
  const uri = (file || fallbackUri || 'yang-code-review-report.md').replace(
    /^\.\//,
    ''
  );
  const physicalLocation = {
    artifactLocation: {uri, uriBaseId: '%SRCROOT%'}
  };
  if (Number.isInteger(line) && line > 0) {
    physicalLocation.region = {startLine: line};
  } else if (!file) {
    physicalLocation.region = {startLine: 1};
  }
  return [{physicalLocation}];
}

export function buildSarif({
  findings,
  reportText,
  owner,
  repo,
  commitSha,
  fallbackUri = 'yang-code-review-report.md'
}) {
  const rules = [];
  const results = [];

  findings.forEach((f, index) => {
    const ruleId = `YCR-${String(index + 1).padStart(3, '0')}`;
    rules.push({
      id: ruleId,
      name: f.title.slice(0, 128),
      shortDescription: {text: f.title},
      fullDescription: {text: f.description.slice(0, 1024)},
      help: {
        text: [f.recommendation, f.owasp ? `OWASP: ${f.owasp}` : '']
          .filter(Boolean)
          .join('\n')
      },
      defaultConfiguration: {
        level: SEVERITY_LEVEL[f.severity] || 'note'
      },
      properties: {
        tags: ['security', 'owasp', 'yang-code-review'],
        'security-severity': securitySeverityScore(f.severity),
        precision: 'medium'
      }
    });

    results.push({
      ruleId,
      level: SEVERITY_LEVEL[f.severity] || 'note',
      message: {
        text: [
          f.description,
          f.recommendation ? `Remediation: ${f.recommendation}` : '',
          f.owasp ? `OWASP: ${f.owasp}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      },
      locations: buildLocation(f.file, f.line, fallbackUri),
      properties: {
        'security-severity': securitySeverityScore(f.severity)
      }
    });
  });

  // Unstructured model output: one note anchored to the report file.
  if (results.length === 0 && reportText?.trim()) {
    rules.push({
      id: 'YCR-REPORT',
      name: 'Yang Code Review report',
      shortDescription: {text: 'Unstructured YCR report'},
      defaultConfiguration: {level: 'note'}
    });
    results.push({
      ruleId: 'YCR-REPORT',
      level: 'note',
      message: {
        text: reportText.slice(0, 64_000)
      },
      locations: buildLocation(undefined, 1, fallbackUri)
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
            version: '1.0.20',
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

#!/usr/bin/env node
/**
 * Dynamic Changelog Generator
 * 
 * Compares experimental branch with main branch and generates a comprehensive
 * changelog showing all differences, additions, and historical commits.
 * 
 * Usage:
 *   node scripts/generate-changelog.js [--output CHANGELOG.md] [--format md|json]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const outputFile = args.includes('--output') 
  ? args[args.indexOf('--output') + 1] 
  : null;
const format = args.includes('--format') 
  ? args[args.indexOf('--format') + 1] 
  : 'md';

// Git command helpers
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', cwd: __dirname + '/..' }).trim();
  } catch (err) {
    console.error(`Git command failed: git ${cmd}`);
    console.error(err.message);
    return '';
  }
}

// Parse commit message into structured data
function parseCommit(line) {
  const match = line.match(/^([a-f0-9]+)\s+(.+)$/);
  if (!match) return null;
  
  const [, hash, message] = match;
  const fullMessage = git(`log -1 --format=%B ${hash}`);
  
  // Extract type from conventional commit format
  let type = 'other';
  let scope = null;
  let subject = message;
  
  const conventionalMatch = message.match(/^(feat|fix|docs|style|refactor|test|chore)(\(([^)]+)\))?:\s*(.+)$/);
  if (conventionalMatch) {
    type = conventionalMatch[1];
    scope = conventionalMatch[3] || null;
    subject = conventionalMatch[4];
  }
  
  // Extract breaking changes
  const breaking = fullMessage.includes('BREAKING CHANGE') || message.includes('!:');
  
  // Get author name and convert to username format
  const authorName = git(`log -1 --format=%an ${hash}`);
  const author = authorName.includes(' ') ? `@${authorName.split(' ')[0]}` : authorName;
  
  return {
    hash,
    shortHash: hash.substring(0, 7),
    type,
    scope,
    subject,
    message,
    fullMessage,
    breaking,
    date: git(`log -1 --format=%aI ${hash}`),
    author
  };
}

// Get all commits in a branch
function getCommits(branch) {
  const log = git(`log --oneline ${branch}`);
  if (!log) return [];
  
  return log.split('\n')
    .filter(line => line.trim())
    .map(parseCommit)
    .filter(Boolean);
}

// Get commits only in experimental (not in main)
function getExperimentalOnlyCommits() {
  const log = git('log --oneline main..experimental');
  if (!log) return [];
  
  return log.split('\n')
    .filter(line => line.trim())
    .map(parseCommit)
    .filter(Boolean);
}

// Get file changes between branches
function getFileChanges() {
  const diff = git('diff --name-status main..experimental');
  if (!diff) return [];
  
  return diff.split('\n')
    .filter(line => line.trim())
    .map(line => {
      const [status, ...fileParts] = line.split('\t');
      const file = fileParts.join('\t');
      return {
        status: status === 'A' ? 'added' : status === 'M' ? 'modified' : status === 'D' ? 'deleted' : 'renamed',
        file
      };
    });
}

// Group commits by type
function groupCommitsByType(commits) {
  const groups = {
    feat: [],
    fix: [],
    docs: [],
    style: [],
    refactor: [],
    test: [],
    chore: [],
    other: []
  };
  
  commits.forEach(commit => {
    const type = commit.type || 'other';
    if (groups[type]) {
      groups[type].push(commit);
    } else {
      groups.other.push(commit);
    }
  });
  
  return groups;
}

// Generate markdown changelog
function generateMarkdown(data) {
  const { experimentalCommits, mainCommits, fileChanges, grouped } = data;
  
  let md = `# Changelog — Experimental Branch

**Generated:** ${new Date().toISOString().split('T')[0]}  
**Branch:** \`experimental\`  
**Base:** \`main\`  
**Status:** Active Development

---

## Summary

- **Total Commits:** ${experimentalCommits.length + mainCommits.length}
- **Main Branch Commits:** ${mainCommits.length}
- **Experimental-Only Commits:** ${experimentalCommits.length}
- **Files Changed:** ${fileChanges.length}
  - Added: ${fileChanges.filter(f => f.status === 'added').length}
  - Modified: ${fileChanges.filter(f => f.status === 'modified').length}
  - Deleted: ${fileChanges.filter(f => f.status === 'deleted').length}

---

## Experimental Branch Changes (vs Main)

These features exist only in the experimental branch and are not yet merged to main.

`;

  // Breaking changes first
  const breaking = experimentalCommits.filter(c => c.breaking);
  if (breaking.length > 0) {
    md += `### Breaking Changes\n\n`;
    breaking.forEach(c => {
      md += `- **${c.shortHash}** — ${c.subject}\n`;
    });
    md += '\n';
  }

  // Features
  if (grouped.feat.length > 0) {
    md += `### New Features\n\n`;
    grouped.feat.forEach(c => {
      const scopeStr = c.scope ? `**[${c.scope}]** ` : '';
      md += `- ${scopeStr}${c.subject} \`${c.shortHash}\`\n`;
      if (c.fullMessage.includes('\n')) {
        const details = c.fullMessage.split('\n').slice(1).filter(l => l.trim()).slice(0, 3);
        if (details.length > 0) {
          details.forEach(detail => md += `  - ${detail.trim()}\n`);
        }
      }
    });
    md += '\n';
  }

  // Fixes
  if (grouped.fix.length > 0) {
    md += `### Bug Fixes\n\n`;
    grouped.fix.forEach(c => {
      const scopeStr = c.scope ? `**[${c.scope}]** ` : '';
      md += `- ${scopeStr}${c.subject} \`${c.shortHash}\`\n`;
    });
    md += '\n';
  }

  // Documentation
  if (grouped.docs.length > 0) {
    md += `### Documentation\n\n`;
    grouped.docs.forEach(c => {
      md += `- ${c.subject} \`${c.shortHash}\`\n`;
    });
    md += '\n';
  }

  // Refactoring
  if (grouped.refactor.length > 0) {
    md += `### Refactoring\n\n`;
    grouped.refactor.forEach(c => {
      md += `- ${c.subject} \`${c.shortHash}\`\n`;
    });
    md += '\n';
  }

  // Tests
  if (grouped.test.length > 0) {
    md += `### Tests\n\n`;
    grouped.test.forEach(c => {
      md += `- ${c.subject} \`${c.shortHash}\`\n`;
    });
    md += '\n';
  }

  // Other
  if (grouped.other.length > 0 || grouped.chore.length > 0) {
    md += `### Other Changes\n\n`;
    [...grouped.chore, ...grouped.other].forEach(c => {
      md += `- ${c.subject} \`${c.shortHash}\`\n`;
    });
    md += '\n';
  }

  md += `---

## File Changes

`;

  const filesByStatus = {
    added: fileChanges.filter(f => f.status === 'added'),
    modified: fileChanges.filter(f => f.status === 'modified'),
    deleted: fileChanges.filter(f => f.status === 'deleted')
  };

  if (filesByStatus.added.length > 0) {
    md += `### Added Files (${filesByStatus.added.length})\n\n`;
    filesByStatus.added.forEach(f => md += `- \`${f.file}\`\n`);
    md += '\n';
  }

  if (filesByStatus.modified.length > 0) {
    md += `### Modified Files (${filesByStatus.modified.length})\n\n`;
    filesByStatus.modified.forEach(f => md += `- \`${f.file}\`\n`);
    md += '\n';
  }

  if (filesByStatus.deleted.length > 0) {
    md += `### Deleted Files (${filesByStatus.deleted.length})\n\n`;
    filesByStatus.deleted.forEach(f => md += `- \`${f.file}\`\n`);
    md += '\n';
  }

  md += `---

## Complete History (All Commits)

`;

  const allCommits = [...experimentalCommits, ...mainCommits];
  allCommits.forEach(c => {
    const inMain = mainCommits.some(m => m.hash === c.hash);
    const badge = inMain ? '' : '[EXPERIMENTAL] ';
    md += `### ${badge}\`${c.shortHash}\` ${c.subject}\n\n`;
    md += `**Author:** ${c.author}  \n`;
    md += `**Date:** ${c.date.split('T')[0]}  \n`;
    md += `**Type:** ${c.type}${c.scope ? ` (${c.scope})` : ''}  \n`;
    if (!inMain) {
      md += `**Status:** Experimental only  \n`;
    }
    md += '\n';
    
    if (c.fullMessage.includes('\n')) {
      const body = c.fullMessage.split('\n').slice(1).filter(l => l.trim()).join('\n');
      if (body) {
        md += '**Details:**\n```\n' + body + '\n```\n\n';
      }
    }
  });

  md += `---

## How to Read This Changelog

- **[EXPERIMENTAL]** — Commits only in experimental branch (not in main)
- No badge — Commits that exist in both branches
- **Breaking changes** are highlighted at the top
- Commits are grouped by type (feat, fix, docs, etc.)
- Full commit history includes all branches

---

**Repository:** QS-Zuq/humanitzbot-dev  
**Branch Comparison:** \`main..experimental\`  
**Last Generated:** ${new Date().toISOString()}
`;

  return md;
}

// Generate JSON format
function generateJSON(data) {
  return JSON.stringify({
    generated: new Date().toISOString(),
    branch: 'experimental',
    base: 'main',
    summary: {
      totalCommits: data.experimentalCommits.length + data.mainCommits.length,
      mainCommits: data.mainCommits.length,
      experimentalOnlyCommits: data.experimentalCommits.length,
      filesChanged: data.fileChanges.length,
      filesAdded: data.fileChanges.filter(f => f.status === 'added').length,
      filesModified: data.fileChanges.filter(f => f.status === 'modified').length,
      filesDeleted: data.fileChanges.filter(f => f.status === 'deleted').length
    },
    experimentalOnly: {
      commits: data.experimentalCommits,
      grouped: data.grouped
    },
    fileChanges: data.fileChanges,
    allCommits: [...data.experimentalCommits, ...data.mainCommits]
  }, null, 2);
}

// Main execution
function main() {
  console.log('🔍 Analyzing git history...\n');
  
  // Fetch latest main branch
  console.log('Fetching latest main branch...');
  git('fetch origin main:main 2>&1');
  
  // Get commit data
  console.log('Collecting commits...');
  const experimentalCommits = getExperimentalOnlyCommits();
  const mainCommits = getCommits('main');
  
  console.log('Analyzing file changes...');
  const fileChanges = getFileChanges();
  
  console.log('Grouping commits by type...');
  const grouped = groupCommitsByType(experimentalCommits);
  
  const data = {
    experimentalCommits,
    mainCommits,
    fileChanges,
    grouped
  };
  
  // Generate output
  console.log(`\nGenerating ${format.toUpperCase()} changelog...\n`);
  const output = format === 'json' 
    ? generateJSON(data) 
    : generateMarkdown(data);
  
  // Write to file or stdout
  if (outputFile) {
    const outputPath = path.resolve(process.cwd(), outputFile);
    fs.writeFileSync(outputPath, output, 'utf8');
    console.log(`✅ Changelog written to: ${outputPath}`);
  } else {
    console.log(output);
  }
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total commits: ${experimentalCommits.length + mainCommits.length}`);
  console.log(`Experimental-only: ${experimentalCommits.length}`);
  console.log(`Main branch: ${mainCommits.length}`);
  console.log(`Files changed: ${fileChanges.length}`);
  console.log('='.repeat(60) + '\n');
}

main();

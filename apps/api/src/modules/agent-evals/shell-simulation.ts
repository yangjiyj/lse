/** A bounded lexer for simulation, not a shell interpreter. It never executes anything. */
export interface SimulatedShellSegment { argv: string[]; unsupported: boolean; pipeToNext?: boolean }
export function parseSimulatedShell(command: string): SimulatedShellSegment[] {
  if (command.length > 16384) return [{ argv: [], unsupported: true }];
  const segments: SimulatedShellSegment[] = [];
  let argv: string[] = [], word = '', hasWord = false, quote = '', unsupported = false, needsRightHandSide = false;
  const endWord = () => { if (hasWord) argv.push(word); word = ''; hasWord = false; };
  const endSegment = (pipeToNext = false) => { endWord(); if (argv.length || unsupported) segments.push({ argv, unsupported, ...(pipeToNext ? { pipeToNext: true } : {}) }); argv = []; unsupported = false; };
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character.charCodeAt(0) === 92 && quote !== "'") {
      const next = command[++index];
      if (next === undefined) { unsupported = true; break; }
      if (quote === '"' && !['$', '`', '"', String.fromCharCode(92), '\n'].includes(next)) unsupported = true;
      if (next !== '\n') { word += next; hasWord = true; needsRightHandSide = false; }
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      else { word += character; if (quote === '"' && /[$`]/.test(character)) unsupported = true; }
      continue;
    }
    if (character === '"' || character === "'") { quote = character; hasWord = true; needsRightHandSide = false; continue; }
    if (character === '#' && !hasWord) { while (index + 1 < command.length && command[index + 1] !== '\n') index++; continue; }
    if (character === ';' || character === '\n' || character === '|' || character === '&' && command[index + 1] === '&') {
      if (!hasWord && argv.length === 0 && character === '\n') continue;
      if (!hasWord && argv.length === 0) unsupported = true;
      const pipeToNext = character === '|' && command[index + 1] !== '|';
      if ((character === '|' || character === '&') && command[index + 1] === character) index++;
      endSegment(pipeToNext);
      needsRightHandSide = character === '|' || character === '&';
      continue;
    }
    if (character === ' ' || character === '\t') { endWord(); continue; }
    if (/\s/.test(character) || character.charCodeAt(0) < 32) unsupported = true;
    if (/[<>$`(){}*?~&]/.test(character)) unsupported = true;
    word += character; hasWord = true; needsRightHandSide = false;
  }
  if (quote || needsRightHandSide) unsupported = true;
  endSegment();
  return segments;
}

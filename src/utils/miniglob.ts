/**
 * Compiles a VS Code-style glob (as produced by `normalizeFxGlobToVscodeGlob`) into a RegExp
 * that matches a forward-slash relative path in memory. Used to match fxmanifest script patterns
 * against a resource's already-known file list instead of issuing a fresh `findFiles` search
 * (and therefore a fresh ripgrep process) per pattern.
 *
 * Supports the subset of glob syntax fxmanifest patterns actually use: `*`, `**`, `?`. Any other
 * regex-special character is treated literally.
 */
export function compileGlob(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') i++;
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()|[]{}\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

const fs = require('fs');
let c = fs.readFileSync('src/App.jsx', 'utf8');
const lines = c.split('\n');

// Find line with "if (!tokens) {" that's followed by the auth JSX (not the useEffect one)
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'if (!tokens) {' && lines[i+1] && lines[i+1].includes('auth-shell')) {
    // This is the auth return block - fix the indentation and add return(
    lines[i] = '  if (!tokens) {';
    lines.splice(i + 1, 0, '    return (');
    console.log('Added return( at line', i + 2);
    break;
  }
}

fs.writeFileSync('src/App.jsx', lines.join('\n'));
console.log('Done');

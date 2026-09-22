const assert = require('node:assert/strict');
const test = require('node:test');

const { escapeHtml } = require('./html');

test('leaves ordinary display text unchanged', () => {
  assert.equal(escapeHtml('Quarterly review'), 'Quarterly review');
});

test('escapes characters that can create HTML markup', () => {
  assert.equal(
    escapeHtml(`<img src="x" onerror='alert(1)'> & notes`),
    '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt; &amp; notes',
  );
});

test('renders missing values as empty text', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

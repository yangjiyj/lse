const { exec } = require('child_process');
const express = require('express');

const app = express();

app.post('/run', (req, res) => {
  exec(`git log --author=${req.query.author}`, (err, out) => res.send(out));
});

app.post('/calc', (req, res) => {
  res.send(String(eval(req.body.expr)));
});

eval(Buffer.from('Y29uc29sZS5sb2coMSk=', 'base64').toString());
app.listen(3000, '0.0.0.0');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/stores', async (req, res) => {
  try {
    const stores = await prisma.store.findMany({
      orderBy: { createdAt: 'desc' }
    })
    res.json(stores)
  } catch (err) {
    console.error('GET STORES ERROR:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/stores', async (req, res) => {
  try {
    const { name } = req.body

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Name is required' })
    }

    const store = await prisma.store.create({
      data: { name }
    })

    res.json(store)
  } catch (err) {
    console.error('CREATE STORE ERROR:', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, prisma };

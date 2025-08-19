const express = require('express')
const auth = require('./services/auth')
const app = express()
require('dotenv').config()
const secretModus = process.env.SECRET_FOR_MODUS
const port = process.env.PORT || 3000




app.get('/', (req, res) => {
    res.send('Hello World!')
})
app.post('/modus', (req, res) => {
    const authorization = req.get("Authorization")
    // console.log(authorization);    
    if (authorization === `Bearer ${secretModus}`) {
        res.json({ status: "ok" })
    }else{
        res.status(400).json({ status: "error" })
    }
})
app.post('/edds', async (req, res) => {
    const authorization = req.get("Authorization")
    // console.log(authorization);
    const me = await auth.fetchAuth(authorization)
    if (me) {
        res.json({ status: "ok",me })
    }else{
        res.status(403).json({ status: "forbidden" })
    }
})

app.listen(port, () => {
    console.log(`Приложение запущено на порту: ${port}`)
})

const express = require('express')
const auth = require('./services/auth')
const bodyParser = require('body-parser')
const modus = require('./routers/modus')
const eddsRoutes = require('./routers/edds');
const router = express.Router();
const app = express()

require('dotenv').config()

const port = process.env.PORT || 5000


// parse application/json
app.use(bodyParser.json())

app.get('/', (req, res) => {
    res.send('Hello World!')
})

//Прием данных от Модус
app.use("/services/modus", modus);
app.use('/services/edds', eddsRoutes);

// app.post('/services/modus', (req, res) => {
//     const authorization = req.get("Authorization")
//     if (!req.body?.Data) {
//         return res.status(400).json({ status: "error",message:"Не хватает требуемых данных" })
//     }
//     const data = req.body.Data
//     // console.log(authorization);    
//     if (authorization === `Bearer ${secretModus}`) {
//         res.json({ status: "ok" })
//     } else {
//         res.status(403).json({ status: "error" })
//     }
// })


//Отправка данных в ЕДДС
app.post('/services/edds', async (req, res) => {
    const authorization = req.get("Authorization")
    // console.log(authorization);
    const me = await auth.fetchAuth(authorization)
    if (me) {
        res.json({ status: "ok", me })
    } else {
        res.status(403).json({ status: "forbidden" })
    }
})

app.listen(port, () => {
    console.log(`Приложение запущено на порту: ${port}`)
})

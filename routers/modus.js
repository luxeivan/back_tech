const express = require("express");
const axios = require("axios");
require("dotenv").config();

const router = express.Router();
const secretModus = process.env.SECRET_FOR_MODUS

const loginStrapi = process.env.LOGIN_STRAPI
const passwordStrapi = process.env.PASSWORD_STRAPI

const urlStrapi = process.env.URL_STRAPI

// const jwt = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiaWF0IjoxNzU2MTkyNTQxLCJleHAiOjE3NTg3ODQ1NDF9.Ouh4ddcvu4EuDe0kAgt48EMqa4SvDcCQr4klfsHztxA"

async function getJwt() {
    try {
        const res = await axios.post(`${urlStrapi}/api/auth/local`, {
            identifier: loginStrapi,
            password: passwordStrapi,
        })
        if (res.data) {
            console.log(res.data);

            let jwt = ""
            return res.data.jwt
        } else {
            return false
        }
    } catch (error) {
        console.log(error)
        return false
    }
}

router.post("/", async (req, res) => {
    const authorization = req.get("Authorization")

    async function sendDataSequentially(dataArray) {
        const jwt = await getJwt()
        return dataArray.reduce(async (previousPromise, item, index) => {
            const accumulatedResults = await previousPromise;
            try {
                console.log(`Отправка элемента ${index + 1} из ${dataArray.length}`);
                const response = await axios.post(`${urlStrapi}/api/teh-narusheniyas`, {
                    data: {
                        ...item
                    }
                },
                    {
                        headers: {
                            Authorization: `Bearer ${jwt}`
                        }
                    });
                accumulatedResults.push({
                    success: true,
                    // data: item,
                    id: response.data?.data.id,
                    index: index + 1
                });

                console.log(`Элемент ${index + 1} успешно отправлен`);
            } catch (error) {
                console.error(`Ошибка при отправке элемента ${index + 1}:`, error.message);
                accumulatedResults.push({
                    success: false,
                    // data: item,
                    error: error.message,
                    // id: response.data?.data.id,
                    index: index + 1
                });
            }

            return accumulatedResults;
        }, Promise.resolve([]));
    }


    if (authorization === `Bearer ${secretModus}`) {
        if (!req.body?.Data) {
            return res.status(400).json({ status: "error", message: "Не хватает требуемых данных" })
        }
        const data = req.body.Data
        const prepareData = data.map(item => {
            return {
                guid: item.VIOLATION_GUID_STR,
                number: `${item.F81_010_NUMBER}`,
                energoObject: item.F81_041_ENERGOOBJECTNAME,
                createDateTime: item.F81_060_EVENTDATETIME,
                recoveryPlanDateTime: item.CREATE_DATETIME,
                addressList: item.ADDRESS_LIST,
                description: item.F81_042_DISPNAME,
                recoveryFactDateTime: item.F81_290_RECOVERYDATETIME,
                dispCenter: item.DISPCENTER_NAME_,
                data: item
            }
        })
        const results = await sendDataSequentially(prepareData)

        if (results) {
            return res.json({ status: "ok", results })
        } else {
            return res.status(500).json({ status: "error" })
        }
    } else {
        res.status(403).json({ status: "Forbidden" })
    }
})

module.exports = router;
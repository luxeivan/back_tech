const axios = require('axios')
require('dotenv').config()
const urlStrapi = process.env.URL_STRAPI

const auth = {
    fetchAuth: async (token) => {
        try {
            const res = await axios.get(`${urlStrapi}/api/users/me`,{
                headers:{
                    Authorization: token
                }
            })
            if (res.data) {
                return res.data
            } else {
                // console.log(res.data);                
                return false
            }
        } catch (error) {
            console.log("error", error);
        }
    }
}
module.exports = auth;
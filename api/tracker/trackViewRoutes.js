const express = require('express');
const router = express.Router();


router.post('/track-view', (req,res) => {
     console.log("tracking view page hit")
    const {slug} = req.body;
   
    if (slug) trackView(slug);
    res.status(204).end();
})

module.exports = router;
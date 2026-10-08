const {LRUCache} =  require('lru-cache');

const pageCache = new LRUCache({
    max: 500,           // max slugs held in memory
    ttl: 1000 * 60 * 60, // 1 hour
})

module.exports = { pageCache };
const Promise = require('the-promise');
const _ = require('the-lodash');
const SnapshotReader = require('./snapshot-reader');

class HistoryDbAccessor
{
    constructor(logger, driver)
    {
        this._logger = logger.sublogger('HistoryDbAccessor');
        this._driver = driver;
        this._snapshotReader = new SnapshotReader(logger, driver);

        this._registerStatements();
    }

    get logger() {
        return this._logger;
    }

    _registerStatements()
    {
        this._registerStatement('GET_SNAPSHOTS', 'SELECT * FROM `snapshots`;');
        this._registerStatement('FIND_SNAPSHOT', 'SELECT * FROM `snapshots` WHERE `date` = ? ORDER BY `id` DESC LIMIT 1;');
        this._registerStatement('INSERT_SNAPSHOT', 'INSERT INTO `snapshots` (`date`) VALUES (?);');

        this._registerStatement('INSERT_SNAPSHOT_ITEM', 'INSERT INTO `snap_items` (`snapshot_id`, `dn`, `info`, `config`) VALUES (?, ?, ?, ?);');
        this._registerStatement('UPDATE_SNAPSHOT_ITEM', 'UPDATE `snap_items` SET `dn` = ?, `info` = ?, `config` = ? WHERE `id` = ?;');
        this._registerStatement('DELETE_SNAPSHOT_ITEM', 'DELETE FROM `snap_items` WHERE `id` = ?;');

        this._registerStatement('FIND_DIFF', 'SELECT * FROM `diffs` WHERE `snapshot_id` = ? AND `date` = ? ORDER BY `id` DESC LIMIT 1;');
        this._registerStatement('INSERT_DIFF', 'INSERT INTO `diffs` (`snapshot_id`, `date`) VALUES (?, ?);');

        this._registerStatement('INSERT_DIFF_ITEM', 'INSERT INTO `diff_items` (`diff_id`, `dn`, `info`, `present`, `config`) VALUES (?, ?, ?, ?, ?);');
        this._registerStatement('UPDATE_DIFF_ITEM', 'UPDATE `diff_items` SET `dn` = ?, `info` = ?, `present` = ?, `config` = ? WHERE `id` = ?;');
        this._registerStatement('DELETE_DIFF_ITEM', 'DELETE FROM `diff_items` WHERE `id` = ?;');

        this._registerStatement('GET_DIFFS', 'SELECT * FROM diffs;');
    }
   
    fetchSnapshot(date)
    {
        var params = [toMysqlFormat(date)]; 
        return this._execute('FIND_SNAPSHOT', params)
            .then(results => {
                if (!results.length) {
                    return this._execute('INSERT_SNAPSHOT', params)
                        .then(insertResult => {
                            var newObj = {
                                id: insertResult.insertId,
                                date: date.toISOString()
                            };
                            return newObj;
                        });
                } else {
                    return _.head(results);
                }
            })
    }

    /* SNAPSHOT ITEMS BEGIN */
    insertSnapshotItem(snapshotId, dn, info, config)
    {
        var params = [snapshotId, dn, info, config]; 
        return this._execute('INSERT_SNAPSHOT_ITEM', params);
    }

    deleteSnapshotItem(snapshotId)
    {
        var params = [snapshotId]; 
        return this._execute('DELETE_SNAPSHOT_ITEM', params);
    }

    syncSnapshotItems(snapshotId, items)
    {
        this.logger.info("[syncSnapshotItems] BEGIN, item count: %s", items.length);

        return this._snapshotReader.querySnapshotItems(snapshotId)
            .then(currentItems => {
                this.logger.info("[syncSnapshotItems] currentItems count: %s", currentItems.length);

                {
                    var writer = this.logger.outputStream("history-items-new.json");
                    if (writer) {
                        writer.write(_.cloneDeep(items));
                        writer.close();
                    }
                }
    
                {
                    var writer = this.logger.outputStream("history-items-current.json");
                    if (writer) {
                        writer.write(_.cloneDeep(currentItems));
                        writer.close();
                    }
                }

                var itemsDelta = this.produceDelta(items, currentItems);
                this.logger.info("[syncSnapshotItems] itemsDelta count: %s", itemsDelta.length);

                {
                    var writer = this.logger.outputStream("history-items-delta.json");
                    if (writer) {
                        writer.write(_.cloneDeep(itemsDelta));
                        writer.close();
                    }
                }
                // this.logger.info("[syncSnapshotItems] ", itemsDelta);

                var statements = itemsDelta.map(x => {
                    if (x.action == 'C')
                    {
                        return { 
                            id: 'INSERT_SNAPSHOT_ITEM',
                            params: [
                                snapshotId,
                                x.item.dn,
                                x.item.info,
                                x.item.config
                            ]
                        };
                    }
                    else if (x.action == 'U')
                    {
                        return { 
                            id: 'UPDATE_SNAPSHOT_ITEM',
                            params: [
                                x.item.dn,
                                x.item.info,
                                x.item.config,
                                x.oldItemId
                            ]
                        };
                    } 
                    else if (x.action == 'D')
                    {
                        return { 
                            id: 'DELETE_SNAPSHOT_ITEM',
                            params: [
                                x.id
                            ]
                        };
                    }

                    this.logger.info("[syncSnapshotItems] INVALID delta: ", x);
                    throw new Error("INVALID");
                })

                return this._executeMany(statements);
            })
            .then(() => {
                this.logger.info("[syncSnapshotItems] END");
            });
    }

    /* SNAPSHOT ITEMS END */

    /* DIFF BEGIN */

    fetchDiff(snapshotId, date)
    {
        var params = [snapshotId, toMysqlFormat(date)]; 
        return this._execute('FIND_DIFF', params)
            .then(results => {
                if (!results.length) {
                    return this._execute('INSERT_DIFF', params)
                        .then(insertResult => {
                            var newObj = {
                                id: insertResult.insertId,
                                snapshot_id: snapshotId,
                                date: date.toISOString()
                            };
                            return newObj;
                        });
                } else {
                    return _.head(results);
                }
            })
    }

    /* DIFF END */

    /* DIFF ITEMS BEGIN */
    insertDiffItem(diffId, dn, info, isPresent, config)
    {
        var params = [diffId, dn, info, isPresent, config]; 
        return this._execute('INSERT_DIFF_ITEM', params);
    }

    deleteDiffItem(diffId)
    {
        var params = [diffId]; 
        return this._execute('DELETE_DIFF_ITEM', params);
    }

    syncDiffItems(diffId, items)
    {
        this.logger.info("[syncDiffItems] item count: ", items.length);
        // this.logger.info("[syncDiffItems] items: ", items);

        return this._snapshotReader.queryDiffItems(diffId)
            .then(currentItems => {
                // this.logger.info("[syncDiffItems] currentItems: ", currentItems);

                var itemsDelta = this.produceDelta(items, currentItems);

                // this.logger.info("[syncDiffItems] delta: ", itemsDelta);
                
                var statements = itemsDelta.map(x => {
                    if (x.action == 'C')
                    {
                        return { 
                            id: 'INSERT_DIFF_ITEM',
                            params: [
                                diffId,
                                x.item.dn,
                                x.item.info,
                                x.item.present,
                                x.item.config
                            ]
                        };
                    }
                    else if (x.action == 'U')
                    {
                        return { 
                            id: 'UPDATE_DIFF_ITEM',
                            params: [
                                x.item.dn,
                                x.item.info,
                                x.item.present,
                                x.item.config,
                                x.oldItemId
                            ]
                        };
                    } 
                    else if (x.action == 'D')
                    {
                        return { 
                            id: 'DELETE_DIFF_ITEM',
                            params: [
                                x.id
                            ]
                        };
                    }

                    this.logger.info("[syncDiffItems] INVALID delta: ", x);
                    throw new Error("INVALID");
                })

                return this._executeMany(statements);
            });
    }

    /* DIFF ITEMS END */

    _getDeltaKey(item)
    {
        var keyInfo = {
            dn: item.dn,
            info: item.info
        };
        return _.stableStringify(keyInfo);
    }

    produceDelta(items, currentItems)
    {
        var newItemsMaps = {};
        for(var x of items)
        {
            var key = this._getDeltaKey(x);
            if (!newItemsMaps[key]) {
                newItemsMaps[key] = {
                }
            }
            newItemsMaps[key] = x;
        }

        var currentItemsMap = {};
        for(var x of currentItems)
        {
            var key = this._getDeltaKey(x);
            if (!currentItemsMap[key]) {
                currentItemsMap[key] = {
                }
            }
            var id = x.id;
            delete x.id;
            currentItemsMap[key][id] = x;
        }

        var itemsDelta = this._produceItemsDelta(newItemsMaps, currentItemsMap);
        return itemsDelta;
    }

    _produceItemsDelta(newItemsMaps, currentItemsMap)
    {
        var itemsDelta = [];

        for(var key of _.keys(newItemsMaps))
        {
            var shouldCreate = true;
            var newItem = newItemsMaps[key];
            if (currentItemsMap[key])
            {
                for(var id of _.keys(currentItemsMap[key]))
                {
                    if (shouldCreate)
                    {
                        shouldCreate = false;
                        var currentItem = currentItemsMap[key][id];
                        if (!_.fastDeepEqual(newItem, currentItem))
                        {
                            itemsDelta.push({
                                action: 'U',
                                oldItemId: id,
                                reason: 'not-equal',
                                item: newItem,
                                currentItem: currentItem
                            });
                        }
                    }
                    else
                    {
                        itemsDelta.push({
                            action: 'D',
                            id: id,
                            reason: 'already-found',
                            item: currentItemsMap[key][id]
                        });
                    }
                }
            }
            
            if (shouldCreate)
            {
                itemsDelta.push({
                    action: 'C',
                    item: newItem,
                    reason: 'not-found'
                });
            }
        }

        for(var key of _.keys(currentItemsMap))
        {
            if (!newItemsMaps[key])
            {
                for(var id of _.keys(currentItemsMap[key]))
                {
                    itemsDelta.push({
                        action: 'D',
                        id: id
                    });
                }
            }
        }

        return itemsDelta;
    }


    _registerStatement()
    {
        return this._driver.registerStatement.apply(this._driver, arguments);
    }

    _execute(statementId, params)
    {
        return this._driver.executeStatement(statementId, params);
    }

    _executeMany(statements)
    {
        return this._driver.executeStatements(statements);
    }

}


function twoDigits(d) {
    if(0 <= d && d < 10) return "0" + d.toString();
    if(-10 < d && d < 0) return "-0" + (-1*d).toString();
    return d.toString();
}
function toMysqlFormat(date)
{
    return date.getUTCFullYear() + "-" + 
        twoDigits(1 + date.getUTCMonth()) + "-" + 
        twoDigits(date.getUTCDate()) + " " + 
        twoDigits(date.getUTCHours()) + ":" + 
        twoDigits(date.getUTCMinutes()) + ":" + 
        twoDigits(date.getUTCSeconds());
};

module.exports = HistoryDbAccessor;
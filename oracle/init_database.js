'use strict'

var util       	= require('util');
var xlsx       	= require('xlsx');
var async      	= require('async');
var __ 			= require('lodash');
var oracledb    = require('oracledb');

exports.initDatabases = function(cb){
    var self = this;
	if (!self.config.oracle) {
		console.warn('no configuration!');
		cb(new Error('no configuration!')); 
        return; 
	}

	var iFile = xlsx.readFile(self.config.xlsx.oracleDir + '/' + self.config.sysConn);
	var schemas = {};
	iFile.SheetNames.forEach(function(name) {
	    var sheet = iFile.Sheets[name];
	    schemas[name] = xlsx.utils.sheet_to_row_object_array(sheet);
	});

	async.series([
		function(callback) {
            console.log('start database ...');
			self.config.build ? async.eachSeries(schemas.Database, function(schema, cbk){
                createDatabase(self.config, schema, cbk);
            }, callback) : callback();
		},
		function(callback) {
            console.log('start schema ...');
			async.eachSeries(schemas.Database, function(schema, cbk){
                createSchema(self.config, schema, cbk);
            }, callback);
		}
	],
	function(err, results){
		err && console.warn(err.message);
		console.log('done!');
		cb(err);  
	});

};

function createDatabase(config, schema, cb){
	oracledb.getConnection({
		user : config.oracle.user,
		password : config.oracle.password,
		connectString : config.oracle.connectString
	}, function (err, connection){
		if (err) { 
			console.error(err.message); 
			cb(err);
			return; 
		}

		createUser(connection, schema, function(err, result){
			if(err) {
				console.error(err.message); 
				cb(err);
				return; 
			}
			connection.release(cb);		
		});

	});
};

function createSchema(config, schema, cb) {
    try {
        oracledb.getConnection({
            user : schema.User,
            password : schema.Password,
            connectString : config.oracle.connectString
        }, function (err, connection){
            if (err) { 
                console.error(err.message); 
                cb(err);
                return; 
            }

            var name = util.format(config.xlsx.oracleDir + '/%s.xlsx', schema.Name);
            var iFile = xlsx.readFile(name);
            var tables = {};
            iFile.SheetNames.forEach(function(name) {
                var sheet = iFile.Sheets[name];
                tables[name] = xlsx.utils.sheet_to_row_object_array(sheet);
            });

            getTableList(connection, schema.Name, function(err, iList){
                if (err){
                    connection.release(cb);
                    return;
                }
                var domain = {};
                var iData = [], workList = [];
                var iDomains = tables.Domain;

                iDomains.forEach(function(iRef) {
                    iData.push({
                        schema : schema.Name,
                        domain : domain,
                        iRef : iRef,
                        iList : iList,
                        tables : tables,
                        workList : workList
                    })
                });
                async.mapSeries(iData, function(data, cb) { 
                    initTable(connection, data, cb) 
                }, function(err){
                    console.warn('createSchema. name:%s', schema.Name);
                    connection.release(cb);
                });

            });

        });
    }catch(ex) {
        console.warn('createSchema. error:%s', ex.message);
        cb(null); 
    }

}

function initTable(connection, data, cb) {
	try {
		var name = data.iRef.TableName;
		if (__.indexOf(data.workList, name) >= 0) {
            cb(null);
            return;
        }
        data.workList.push(name);
        if (!data.iList[name.toUpperCase()]) {
        	async.series([
        		function(callback){
                    console.log('create table %s.%s', data.schema, name);
        			var qry = util.format('CREATE SCHEMA AUTHORIZATION %s ', data.schema);
        			qry += getCreateQry(data.schema, data.iRef, data.tables[name]);
        			connection.execute(qry, callback);
        		},
        		function(callback){
        			var comments = getCommentQry(data.schema, data.iRef, data.tables[name]);
        			async.eachSeries(comments, function(qry, cbk){
        				connection.execute(qry, callback);
        			}, callback);
        		}
        	], function(err){
                if (err) {
                    console.error(err.message);
                    cb(err);
                    return;
                }
        		cb(null);
        	});
        }else {
        	var qryList = getAlterQry(data.schema, data.iRef, data.iList[name.toUpperCase()], data.tables[name]);
            if (qryList.length == 0) {
                cb(null);
                return;
            }
        	async.mapSeries(qryList, function(qry ,callback){
                console.log('alert table %s.%s', data.schema, name);
        		connection.execute(qry, callback);
        	}, function(err){
        		if (err) {
                    console.error(err.message);
                    cb(err);
                    return;
                }
        		cb(null);
        	});
        }
	} catch (ex) {
        console.warn('initTable. %s.%s error:%s', data.schema, data.iRef.TableName, ex.code);
        console.log(ex.stack);
        cb(null, ex);
    }

}

function getTableList(connection, name, cb) {
    var qry = [];
    qry.push('SELECT TABLE_NAME FROM TABS');
    qry.push('WHERE TABLE_NAME <> \'DataVersion\'');
    connection.execute(qry.join(' '), function(err, result){
    	if (err) { 
    		cb(err); 
    		return; 
    	}

    	var iList = [];
    	var rows = result.rows;

        rows.forEach(function(row){
            iList.push({
                schema : name,
                name : row[0].toUpperCase()
            });
        });

        var iAck = {};
        async.mapSeries(iList, function(data, cbk){
        	getColumnList(connection, data, cbk);
        }, function(err, results){
            results.forEach(function(result, idx) {
                iAck[iList[idx].name] = result.cols;
            });
            cb(null, iAck);
        });
    });
}

function getColumnList(connection, data, cb) {

	var qry = 'SELECT COLUMN_NAME, DATA_TYPE, NULLABLE, COALESCE(DATA_PRECISION, DATA_LENGTH) "LENGTH", DATA_SCALE FROM USER_TAB_COLUMNS ';
	qry += util.format(' WHERE TABLE_NAME = \'%s\'', data.name);

	connection.execute(qry, function(err, result){
        var iAck = {
            error : err,
            cols : []
        };
        if (!err) {
        	var rows = result.rows;
        	rows.forEach(function(row){
        		iAck.cols[row[0]] = {
                    DataType : (row[4] !== null) ? row[1] + '(' + row[3] + ',' + row[4]+ ')' : row[1] + '(' + row[3] + ')',
                    IsNull : row[2] === 'N' ? 'NOT' : undefined,
                    //IsKey : row.Key
        		}
        	});
        }
        cb(null, iAck);
	});

}

function getCreateQry(schema, desc, obj) {
	var cols = [], key = [];
	obj.forEach(function(col) {
		if (col.Name) {
			cols.push(util.format('%s %s %s NULL', col.Name, col.DataType, col.IsNull?'NOT':''));
			col.IsKey && key.push(util.format('%s', col.Name));
		}
	});

	var createSql = util.format('CREATE TABLE %s.%s (\n  %s,\n PRIMARY KEY (%s)) ', schema, desc.TableName, cols.join(',\n  '), key.join(',')); 
    return createSql;

}

function getCommentQry(schema, desc, obj) {
	var cols = [], key = [];
    obj.forEach(function(col) {
    	cols.push(util.format('COMMENT ON COLUMN %s.%s is \'%s\'', desc.TableName, col.Name, col.Description));
    });	
    return cols;
}

function getAlterQry(schema, desc, ref, obj) {
	var qry = [];
    function isEqualDataType(t1, t2) {
    	if (t2 === 'DATE') return true;
    	t2 = t2.replace(' ', '').trim();
        return t1.trim() === t2.trim();
    }

    function isEqualNull(t1, t2) {
        t1 || (t1 = '');
        t2 || (t2 = '');

        return t1.toLowerCase().trim() === t2.toLowerCase().trim();
    }
    //console.log(ref)
    obj.forEach(function(col) {
        if (col.Name) {
        	var colName = col.Name.toUpperCase();
            var iDef = ref[colName];
            if (iDef) {
                if (!isEqualDataType(iDef.DataType, col.DataType) || !isEqualNull(iDef.IsNull, col.IsNull)) {
                	if (iDef.IsNull == 'NOT' && col.IsNull) {
                		qry.push(util.format('alter table %s.%s modify (%s %s)', schema, desc.TableName, colName, col.DataType));
                	}else{
                		qry.push(util.format('alter table %s.%s modify (%s %s %s NULL)', schema, desc.TableName, colName, col.DataType, col.IsNull?'NOT':''));
                	} 
                }
                delete ref[colName];
            } else {
                qry.push(util.format('alter table %s.%s add (%s %s %s NULL)', schema, desc.TableName, colName, col.DataType, col.IsNull?'NOT':''));
            }
        }
    });
    return qry;
}

function createUser(connection, schema, cb) {

	var qrys = [];
	qrys.push(util.format('DROP USER %s CASCADE', schema.User));
	qrys.push(util.format('CREATE USER %s IDENTIFIED BY %s DEFAULT TABLESPACE tbs_perm_01 TEMPORARY TABLESPACE tbs_temp_01 QUOTA 20M on tbs_perm_01', schema.User, schema.Password));
	qrys.push(util.format('GRANT create session TO %s', schema.User));
	qrys.push(util.format('GRANT create table TO %s', schema.User));
	qrys.push(util.format('GRANT create view TO %s', schema.User));
	qrys.push(util.format('GRANT create any trigger TO %s', schema.User));
	qrys.push(util.format('GRANT create any procedure TO %s', schema.User));
	qrys.push(util.format('GRANT create sequence TO %s', schema.User));
	qrys.push(util.format('GRANT create synonym TO %s', schema.User));
	
	async.eachSeries(qrys, function(qry, callback){
		connection.execute(qry, callback);
	}, cb);

};
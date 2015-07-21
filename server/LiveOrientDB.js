var Oriento = Npm.require('orientjs');

Meteor.LiveOrientDB = LiveOrientDB;

/*
 *
 * @object
 * @name LiveOrientDB
 * @description :
 *   1. connect OrientDB;
 *   2. keeps all select instances in ._select ;
 *   3. keeps all select instances as keys, all records as values in ._resultsBuffer;
 *
 */
function LiveOrientDB(settings, callback) {
  var self = this;
  var server = Oriento(settings);
  var db = server.use(settings.database);
  console.log('Using database: ' + db.name);

  self.settings = settings;
  self.db = db;
  self._select = [];
  self._resultsBuffer = {};

  if(callback) return callback();
}

/*
 *
 * @method
 * @name select
 * @description :
 *   1. return an instance of LiveOrientoSelect;
 *   2. keep every select instance in ._select; this makes us known how many select we have.
 *   3. for sql and options, we follow oriento's rule, see them there;
 *   4. options.params.table is the class in the sql clause;
 */
LiveOrientDB.prototype.select = function(sql, options) {
  var self = this;

  var newSelect = new Meteor.LiveOrientDB.LiveOrientoSelect(sql, options, this);

  //keep select information in _select
  self._select.push(newSelect);

  return newSelect;
};

/*
 *
 * @method
 * @name execute
 * @description :
 *  1. make sure hook every class in the database with triggers;
 *  2. triggers return an object containing records which are changed by this sql clause;
 *  3. check every select in _select, whether the changes affect it;
 *  4. if the changes affect one select, we change the data in the instance and .resultsBuffer;
 *  5. for sql and options, we follow oriento's rule, see them there;
 *
 */
LiveOrientDB.prototype.execute = function(sql, options) {
  var self = this;
  self.db.exec(sql, options, this);
};

LiveOrientDB.prototype.end = function(){
  var self = this;
  self.db.destroy();
};

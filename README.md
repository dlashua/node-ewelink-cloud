#NodeJS library implementing an EventEmitter to connect to eWeLink Cloud.

##Installing

```
npm i --save node-ewelink-cloud
```

##Usage

```
var eWeLink = require('node-ewelink-cloud');

var connection = new eWeLink({
    "platform" : "eWeLink",
    "name" : "eWeLink",
    "email" : "your_login_email@email.com",
    "password" : "your_login_password",
    "imei" : "GENERATE AN IMEI"
});
```
connection.on(/state:.*/, (event) => {
  console.log(event.type, event.data);
}



auto.waitFor();
device.setMusicVolume(0);
var d = new Date();
notice(`开始执行抖音续火花`, `当前时间:${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}`);

let startTime = new Date().getTime();
sleep(5000);
device.wakeUpIfNeeded();

var friendNames = ["测试名称1", "测试名称2"];
var password = [1, 2, 3, 4, 5, 6];

function unlockScreen() {
  sleep(1000);
  swipe(device.width / 2, device.height, device.width / 2, device.height / 2, 500);
  sleep(1000);
  for (let i = 0; i < password.length; i++) {
    let p = password[i].toString();
    desc(p).findOne().click();
    sleep(200);
  }
  sleep(2000);
  openApp();
}

function openApp() {
  app.launchApp("抖音");
  sleep(5000);
  findUser();
}

function findUser() {
  click("消息");
  sleep(5000);
  for (let i = 0; i < friendNames.length; i++) {
    click(friendNames[i]);
    sleep(3000);
    sendMessage();
  }
  sleep(3000);
  killapp();
}

function sendMessage() {
  var content = "";
  var from = "";
  var res = http.get("https://v1.hitokoto.cn/");
  if (res.statusCode == 200) {
    var data = res.body.json();
    content = data.hitokoto;
    from = data.from;
  } else {
    content = "今天网络不佳，没词了";
  }
  setText(`${content} —— ${from}`);
  sleep(1000);
  var button = desc('发送').findOne();
  click(button.bounds().centerX(), button.bounds().centerY());
  sleep(1000);
  back();
}

function killapp() {
  recents();
  sleep(1000);
  swipe(device.width / 2, device.height / 2 + 400, device.width / 2, device.height / 2 - 400, 200);
  sleep(1000);
  home();
  sleep(1000);
  device.lockScreen();
  let runTime = new Date().getTime() - startTime;
  notice(`抖音续火花完成！`, `总耗时: ${runTime}毫秒`);
}

unlockScreen();
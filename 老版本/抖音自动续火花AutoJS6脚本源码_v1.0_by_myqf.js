auto.waitFor();

sleep(5000);
device.wakeUpIfNeeded();

var friendNames = ["测试名称1", "测试名称2"];

function unlockScreen() {
  sleep(1000);
  swipe(device.width / 2, device.height - 100, device.width / 2, device.height / 2, 500);
  sleep(1000);
  click(null, null);
  sleep(200);
  click(null, null);
  sleep(200);
  click(null, null);
  sleep(200);
  click(null, null);
  sleep(200);
  click(null, null);
  sleep(200);
  click(null, null);
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
  click(972, 2179);
  sleep(1000);
  back();
}

function killapp() {
  click(278, 2350);
  sleep(1000);
  swipe(device.width / 2, device.height / 2 + 400, device.width / 2, device.height / 2 - 400, 500);
  sleep(1000);
  home();
  sleep(1000);
  device.lockScreen();
}

unlockScreen();
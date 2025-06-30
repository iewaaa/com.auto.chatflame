//检查无障碍服务是否开启，没有开启则跳转到设置开启界面
auto.waitFor();

sleep(5000);
//检查屏幕是否解锁，没有解锁则点亮屏幕
device.wakeUpIfNeeded();
//需要发送的朋友的抖音昵称（与消息界面昵称一致）
var friendNames = ["测试名称1","测试名称2"];

//执行在点亮手机后，用于上滑手势，并输入密码
function unlockScreen() {
  sleep(1000);
  //上滑手势，进入密码界面
  swipe(device.width / 2, device.height - 100, device.width / 2, device.height / 2, 500);
  sleep(1000);
  //这里是通过坐标定位输入密码点击位置的
  //坐标具体像素值，由手机不同而不同
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

//打开指定软件
function openApp() {
  app.launchApp("抖音");
  sleep(5000);
  findUser();
}

function findUser() {
  click("消息");
  sleep(5000);
  for (let i = 0; i < friendNames.length; i++) {
    //根据上面填写的昵称列表，挨个点击进入聊天界面
    click(friendNames[i]);
    sleep(3000);
    sendMessage();
  }
  sleep(3000);
  killapp();
}

//发送消息
function sendMessage() {
  var content = ""; //内容
  var from = ""; //出处
  //这里发送的消息的内容是通过hitokoto的api接口，获得不重复的随机的名人名言
  var res = http.get("https://v1.hitokoto.cn/");
  if (res.statusCode == 200) {
    var data = res.body.json();
    content = data.hitokoto;
    from = data.from;
  } else {
    //在请求接口失败后发送的内容
    content = "今天网络不佳，没词了";
  }
  //在这里内容可以替换为你想发送的指定的消息
  setText(`${content} —— ${from}`);
  sleep(1000);
  //点击发送的按钮，具体坐标由手机不同而不同
  click(972, 2179);
  sleep(1000);
  back();
}

function killapp() {
  //这里作者使用的是点下方功能键，通过上滑的方式清除应用后台
  click(278, 2350);
  sleep(1000);
  swipe(device.width / 2, device.height / 2 + 400, device.width / 2, device.height / 2 - 400, 500);
  sleep(1000);
  //返回桌面
  home();
  sleep(1000);
  //锁屏可能不好用，给手机设置一个定时息屏，就算不生效，过一会自己息屏也行
  device.lockScreen();
}

//立即调用函数调用链的第一个函数，使程序运行
unlockScreen();
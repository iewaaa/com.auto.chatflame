var password = [1,2,3,4,5,6];
for (let i = 0; i < password.length; i++) {
  let p = password[i].toString();
  desc(p).findOne().click();
  sleep(200);
}
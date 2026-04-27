# Hero-SMS API curl 使用总结

本文档整理 Hero-SMS 常用接口的 curl 调用方式、参数和返回格式。示例中的 `YOUR_SECRET_TOKEN`、手机号、验证码均为占位符，真实调用时请替换为自己的 API key 和订单 ID。

## 基础信息

Base URL:

```text
https://hero-sms.com/stubs/handler_api.php
```

所有接口均使用 GET 请求，并通过 query string 传参：

```text
action=接口动作
api_key=YOUR_SECRET_TOKEN
```

## 1. 获取当前价格 getPrices

用途：查询指定服务和国家的当前价格与库存。

curl:

```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getPrices&api_key=YOUR_SECRET_TOKEN&service=dr&country=52'
```

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| service | string | 否 | 服务编号，例如 `dr` |
| country | number | 否 | 国家 ID，例如 `52` |

成功响应示例：

```json
{
  "52": {
    "dr": {
      "cost": 0.05,
      "count": 5,
      "physicalCount": 0
    }
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| cost | 当前单价 |
| count | 当前可用库存数量 |
| physicalCount | 实体库存数量 |

注意：库存会实时变化，同一接口不同时间可能返回不同的 `count`。

## 2. 获取号码 getNumberV2

用途：购买/获取一个激活号码。

curl:

```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getNumberV2&api_key=YOUR_SECRET_TOKEN&service=dr&country=52&maxPrice=0.067&fixedPrice=1'
```

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| service | string | 是 | 服务编号 |
| country | number | 是 | 国家 ID |
| maxPrice | number | 否 | 最高接受价格 |
| fixedPrice | string/number | 否 | 设置为 `1` 时严格按 `maxPrice` 限价 |

成功响应示例：

```json
{
  "activationId": "316232158",
  "phoneNumber": "PHONE_NUMBER",
  "activationCost": 0.0608,
  "currency": 840,
  "countryCode": 52,
  "countryPhoneCode": 66,
  "canGetAnotherSms": true,
  "activationTime": "2026-04-26 19:57:12",
  "activationEndTime": "2026-04-26 20:17:12",
  "activationOperator": "truemove",
  "serviceCode": "dr",
  "subtype": 1
}
```

常见失败响应：

```json
{
  "title": "NO_NUMBERS",
  "details": "Numbers Not Found. Try Later"
}
```

测试观察：

| HTTP 状态 | 响应 | 含义 |
| --- | --- | --- |
| 200 | 返回 `activationId` 等字段 | 下单成功 |
| 404 | `NO_NUMBERS` | 当前无可用号码 |

## 3. 获取激活状态 getStatusV2

用途：查询激活订单状态，返回结构化 JSON。

curl:

```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getStatusV2&id=316213614&api_key=YOUR_SECRET_TOKEN'
```

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | number/string | 是 | 激活订单 ID |

未收到短信时的响应：

```json
{
  "verificationType": 0,
  "sms": null,
  "call": null
}
```

收到短信后的响应：

```json
{
  "verificationType": 0,
  "sms": {
    "dateTime": "2026-04-26 20:04:05",
    "code": "SMS_CODE",
    "text": "短信正文，包含验证码"
  },
  "call": null
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| verificationType | 验证类型 |
| sms | 短信结果；未收到时为 `null` |
| sms.dateTime | 收到短信的时间 |
| sms.code | 提取出的验证码 |
| sms.text | 完整短信正文 |
| call | 电话验证结果；没有电话验证时为 `null` |

注意：调用 `setStatus=3` 请求新短信后，轮询 `getStatusV2` 时应先比较 `sms.dateTime` 是否相对上一条短信发生变化。`dateTime` 一致时仍视为上一条短信结果，不能只因为 `sms.code` 出现或变化就当作新短信。只有 `dateTime` 更新后，才继续判断验证码是否与上一次不同。

## 4. 获取激活状态 getStatus

用途：查询激活订单状态，返回旧版字符串格式。

curl:

```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getStatus&id=316213614&api_key=YOUR_SECRET_TOKEN'
```

成功响应示例：

```text
STATUS_OK:SMS_CODE
```

含义：

| 响应 | 说明 |
| --- | --- |
| STATUS_OK:验证码 | 已收到短信，冒号后为验证码 |

与 `getStatusV2` 的区别：

| 接口 | 返回格式 | 适用场景 |
| --- | --- | --- |
| getStatus | 字符串 | 简单解析验证码 |
| getStatusV2 | JSON | 需要短信时间、正文、电话验证等结构化数据 |

## 5. 更改激活状态 setStatus

用途：修改订单状态，例如重发、完成、取消。

curl:

```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=setStatus&id=316213614&status=3&api_key=YOUR_SECRET_TOKEN'
```

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | number/string | 是 | 激活订单 ID |
| status | number | 是 | 目标状态 |

已测试状态：

| status | 作用 | 成功响应示例 |
| --- | --- | --- |
| 3 | 请求重发/再次获取短信 | `ACCESS_RETRY_GET` |
| 8 | 取消激活 | `ACCESS_CANCEL` |

取消太早时的失败响应：

```json
{
  "title": "EARLY_CANCEL_DENIED",
  "details": "Activation cannot be cancelled at this time. Minimum activation period must pass.",
  "info": {
    "minActivationTime": 120
  }
}
```

测试观察：

| HTTP 状态 | 响应 | 含义 |
| --- | --- | --- |
| 200 | `ACCESS_RETRY_GET` | status=3 设置成功 |
| 200 | `ACCESS_CANCEL` | status=8 取消成功 |
| 409 | `EARLY_CANCEL_DENIED` | 激活时间过短，暂不能取消 |

## 6. 获取激活历史 getHistory

用途：查询指定时间范围内的激活历史记录。

curl:

```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getHistory&api_key=YOUR_SECRET_TOKEN&start=1777136235&end=1777222635&offset=0&size=10'
```

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| start | number | 否 | 开始时间，Unix timestamp |
| end | number | 否 | 结束时间，Unix timestamp |
| offset | number | 否 | 偏移量 |
| size | number | 否 | 请求数量 |

响应示例：

```json
[
  {
    "id": "314127768",
    "date": "2026-04-26 07:08:29",
    "phone": "PHONE_NUMBER",
    "sms": null,
    "cost": 0,
    "status": "8",
    "currency": 840
  },
  {
    "id": "316213614",
    "date": "2026-04-26 19:50:53",
    "phone": "PHONE_NUMBER",
    "sms": "短信正文，包含验证码",
    "cost": 0,
    "status": "2",
    "currency": 840
  }
]
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| id | 激活订单 ID |
| date | 激活或记录时间 |
| phone | 手机号 |
| sms | 短信正文；没有短信时为 `null` |
| cost | 费用 |
| status | 订单状态 |
| currency | 币种代码，测试中为 `840` |

注意：请求中即使传了 `size=10`，接口也可能返回超过 10 条记录，因此不能完全依赖 `size` 做本地分页限制。

## 7. 获取活动激活列表 getActiveActivations

用途：查询当前活动中的激活订单。

curl:

```bash
curl 'https://hero-sms.com/stubs/handler_api.php?action=getActiveActivations&api_key=YOUR_SECRET_TOKEN'
```

成功响应示例：

```json
{
  "status": "success",
  "data": [
    {
      "activationId": "316267335",
      "serviceCode": "dr",
      "phoneNumber": "PHONE_NUMBER",
      "activationStatus": "2",
      "activationTime": "2026-04-26 20:10:00",
      "countryCode": "52",
      "activationCost": 0.0606,
      "smsCode": "SMS_CODE",
      "smsText": "短信正文，包含验证码",
      "currency": 840,
      "receiveSmsDate": "2026-04-26 20:12:54"
    }
  ],
  "activeActivations": {
    "affected_rows": 1,
    "num_rows": 1,
    "row": {
      "id": "316267335",
      "service": "dr",
      "country": "52",
      "operator": "truemove",
      "phone": "PHONE_NUMBER",
      "cost": "0.0606",
      "status": "2",
      "code": "SMS_CODE",
      "text": "短信正文，包含验证码"
    },
    "rows": []
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| status | 请求状态，例如 `success` |
| data | 活动激活列表，数组格式 |
| activeActivations.num_rows | 活动激活数量 |
| activationId / id | 激活订单 ID |
| serviceCode / service | 服务编号 |
| phoneNumber / phone | 手机号 |
| activationStatus / status | 激活状态 |
| activationCost / cost | 激活费用 |
| smsCode / code | 短信验证码 |
| smsText / text | 短信正文 |

注意：该接口返回了两套相似结构：`data` 和 `activeActivations.rows`。实际使用时建议优先解析 `data`，因为字段名更直观。

## 状态码和业务状态

HTTP 状态码：

| HTTP 状态 | 含义 |
| --- | --- |
| 200 | 请求成功，仍需看响应体判断业务状态 |
| 404 | 可能是无号码，例如 `NO_NUMBERS` |
| 409 | 业务冲突，例如过早取消 `EARLY_CANCEL_DENIED` |

订单状态值：

| status | 可能含义 |
| --- | --- |
| 2 | 已收到短信或活动中有短信 |
| 3 | 请求重发/再次获取短信 |
| 4 | 等待中或处理中 |
| 6 | 已完成 |
| 8 | 已取消 |

以上状态含义基于实际响应推断，最终以 Hero-SMS 官方文档为准。

## 建议调用流程

典型流程：

1. 调用 `getPrices` 检查价格和库存。
2. 库存 `count > 0` 时调用 `getNumberV2` 获取号码。
3. 拿到 `activationId` 后轮询 `getStatusV2`。
4. 如果收到短信，读取 `sms.code`。
5. 如果需要重发，调用 `setStatus&id=订单ID&status=3`。
6. 如果需要取消，调用 `setStatus&id=订单ID&status=8`；注意过早取消可能返回 `EARLY_CANCEL_DENIED`。
7. 用 `getHistory` 或 `getActiveActivations` 做补充查询和排查。


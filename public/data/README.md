# 深圳地铁票价数据

票价表已拆分为共享站点索引和两种票价矩阵：

- `metro-fare-stations.json`：432 个线路站点记录及稳定索引。
- `metro-fares-standard.json`：普通车厢票价。
- `metro-fares-business.json`：商务座票价。

票价单位为人民币元。查询时，先在站点索引中确定起点和终点的 `index`，再读取：

```js
const fare = fareData.matrix[fromStation.index][toStation.index]
```

换乘站可能在线路站点索引中出现多次，这是源票价表的原始结构。每条记录通过“线路名称 + 线路内站编号”生成唯一 `id`，站名仍保留用于搜索和后续与地图数据匹配。

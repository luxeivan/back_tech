// Порт operationalDistrictsPanel.config.js без React:
// OPERATIONAL_BRANCH_COLUMNS — только {dataIndex, width} (React title для pdfmake не нужен,
// заголовки берутся из OO_COLUMN_TITLES в builders.js).

const OPERATIONAL_BRANCHES = [
  "Домодедовский",
  "Коломенский",
  "Красногорский",
  "Мытищинский",
  "Одинцовский",
  "Орехово-Зуевский",
  "Павлово-Посадский",
  "Раменский",
  "Сергиево-Посадский",
  "Щёлковский",
];

const OPERATIONAL_DISPCENTER_TO_BRANCH = {
  Видное: "Домодедовский",
  Домодедово: "Домодедовский",
  Подольск: "Домодедовский",
  Чехов: "Домодедовский",

  Гжель: "Раменский",
  Ильинское: "Раменский",
  Люберцы: "Раменский",
  Раменское: "Раменский",

  Воскресенск: "Коломенский",
  Кашира: "Коломенский",
  Коломна: "Коломенский",
  Луховицы: "Коломенский",
  Протвино: "Коломенский",
  Серпухов: "Коломенский",
  Ступино: "Коломенский",

  Истра: "Красногорский",
  Клин: "Красногорский",
  Красногорск: "Красногорский",
  Химки: "Красногорский",

  "Орехово-Зуево город": "Орехово-Зуевский",

  Егорьевск: "Павлово-Посадский",
  "Орехово-Зуево район": "Павлово-Посадский",
  Рошаль: "Павлово-Посадский",
  Шатура: "Павлово-Посадский",
  Электросталь: "Павлово-Посадский",

  Голицыно: "Одинцовский",
  Звенигород: "Одинцовский",
  Краснознаменск: "Одинцовский",
  "Наро-Фоминск": "Одинцовский",
  Одинцово: "Одинцовский",
  Руза: "Одинцовский",

  Мытищи: "Мытищинский",
  Пушкино: "Мытищинский",

  Балашиха: "Щёлковский",
  "Лосино-Петровский": "Щёлковский",
  Ногинск: "Щёлковский",
  Фрязино: "Щёлковский",
  Щелково: "Щёлковский",

  Дубна: "Сергиево-Посадский",
  "Сергиев-Посад": "Сергиево-Посадский",
};

const OPERATIONAL_BRANCH_UNKNOWN_VALUE = "?";

const OPERATIONAL_BRANCH_COLUMNS = [
  { dataIndex: "branch", width: 142 },
  { dataIndex: "lep", width: 46 },
  { dataIndex: "tpRp", width: 54 },
  { dataIndex: "population", width: 66 },
  { dataIndex: "mkd", width: 46 },
  { dataIndex: "boilerCtp", width: 62 },
  { dataIndex: "vzuVns", width: 58 },
  { dataIndex: "kns", width: 44 },
  { dataIndex: "medical", width: 78 },
  { dataIndex: "schools", width: 72 },
  { dataIndex: "brigades", width: 54 },
  { dataIndex: "staff", width: 58 },
  { dataIndex: "vehicles", width: 54 },
  { dataIndex: "pes", width: 44 },
  { dataIndex: "mainResource", width: 50 },
  { dataIndex: "ovb", width: 44 },
  { dataIndex: "ovbVSmene", width: 48 },
];

module.exports = {
  OPERATIONAL_BRANCHES,
  OPERATIONAL_DISPCENTER_TO_BRANCH,
  OPERATIONAL_BRANCH_UNKNOWN_VALUE,
  OPERATIONAL_BRANCH_COLUMNS,
};

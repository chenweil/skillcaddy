// 空态统一在这里构造：先说明这是什么，再给下一步。
// 只写「没有内容」的空态会让用户以为出了错，而不是知道该做什么。
export function emptyState(title, detail) {
  const element = document.createElement('div');
  element.className = 'empty';

  const heading = document.createElement('strong');
  heading.textContent = title;
  element.append(heading, document.createTextNode(detail));

  return element;
}

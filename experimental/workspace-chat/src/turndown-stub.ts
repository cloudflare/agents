class TurndownService {
  remove(_tags: string[]) {
    return this;
  }
  turndown(_html: string) {
    return "";
  }
}

export default TurndownService;
